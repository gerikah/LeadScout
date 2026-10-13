create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email, updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert or update of email on auth.users
for each row execute procedure public.handle_new_user();

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id text not null check (length(source_id) between 1 and 200),
  name text not null check (length(name) between 1 and 500),
  category text not null default '',
  address text not null default '',
  location text not null default '',
  website text not null default '',
  phone text not null default '',
  email text not null default '',
  latitude double precision,
  longitude double precision,
  source_url text not null default '',
  status text not null default 'New'
    check (status in ('New', 'To Contact', 'Contacted', 'Follow-up', 'Interested', 'Not Interested', 'Closed')),
  notes text not null default '' check (length(notes) <= 10000),
  saved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source_id),
  unique (id, user_id)
);

create index if not exists leads_user_saved_idx on public.leads (user_id, saved_at desc);
create index if not exists leads_user_status_idx on public.leads (user_id, status);

create table if not exists public.website_audits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lead_id uuid not null,
  audit_data jsonb not null check (jsonb_typeof(audit_data) = 'object'),
  checked_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (lead_id, checked_at),
  constraint website_audits_lead_user_fk
    foreign key (lead_id, user_id) references public.leads(id, user_id) on delete cascade
);

create index if not exists website_audits_user_lead_checked_idx
  on public.website_audits (user_id, lead_id, checked_at desc);

create table if not exists public.api_rate_limit_windows (
  policy text not null check (policy in ('search', 'audit')),
  identity_hash text not null,
  window_start timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (policy, identity_hash, window_start)
);

create index if not exists api_rate_limit_expiry_idx
  on public.api_rate_limit_windows (window_start);

create table if not exists public.audit_concurrency_leases (
  lease_id uuid primary key,
  expires_at timestamptz not null
);

alter table public.profiles enable row level security;
alter table public.leads enable row level security;
alter table public.website_audits enable row level security;
alter table public.api_rate_limit_windows enable row level security;
alter table public.audit_concurrency_leases enable row level security;

drop policy if exists "Users read own profile" on public.profiles;
create policy "Users read own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

drop policy if exists "Users read own leads" on public.leads;
create policy "Users read own leads" on public.leads
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users insert own leads" on public.leads;
create policy "Users insert own leads" on public.leads
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users update own leads" on public.leads;
create policy "Users update own leads" on public.leads
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users delete own leads" on public.leads;
create policy "Users delete own leads" on public.leads
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Users read own website audits" on public.website_audits;
create policy "Users read own website audits" on public.website_audits
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users add own website audits" on public.website_audits;
create policy "Users add own website audits" on public.website_audits
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.leads
      where leads.id = website_audits.lead_id and leads.user_id = (select auth.uid())
    )
  );

create or replace function public.consume_api_rate_limit(
  p_policy text,
  p_identity_hash text,
  p_authenticated boolean
)
returns table (allowed boolean, retry_after integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  policy_limit integer;
  current_window timestamptz;
  request_total integer;
begin
  if p_policy not in ('search', 'audit') or length(p_identity_hash) not between 1 and 128 then
    raise exception 'invalid rate limit request';
  end if;
  policy_limit := case
    when p_policy = 'search' and p_authenticated then 30
    when p_policy = 'search' then 10
    when p_authenticated then 10
    else 5
  end;
  current_window := to_timestamp(floor(extract(epoch from now()) / 60) * 60);

  insert into public.api_rate_limit_windows as existing (policy, identity_hash, window_start, request_count)
  values (p_policy, p_identity_hash, current_window, 1)
  on conflict (policy, identity_hash, window_start)
  do update set request_count = existing.request_count + 1
  returning request_count into request_total;

  delete from public.api_rate_limit_windows
  where window_start < now() - interval '10 minutes';

  return query select request_total <= policy_limit,
    case when request_total <= policy_limit then 0
      else greatest(1, ceil(extract(epoch from (current_window + interval '1 minute' - now())))::integer)
    end;
end;
$$;

create or replace function public.acquire_audit_concurrency_lease(p_lease_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('leadscout-audit-concurrency'));
  delete from public.audit_concurrency_leases where expires_at <= now();
  select count(*) into active_count from public.audit_concurrency_leases;
  if active_count >= 2 then return false; end if;
  insert into public.audit_concurrency_leases (lease_id, expires_at)
  values (p_lease_id, now() + interval '30 seconds');
  return true;
end;
$$;

create or replace function public.release_audit_concurrency_lease(p_lease_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.audit_concurrency_leases where lease_id = p_lease_id;
$$;

revoke all on public.profiles, public.leads, public.website_audits from anon, public;
revoke all on public.profiles, public.api_rate_limit_windows, public.audit_concurrency_leases from anon, authenticated;
revoke all on function public.consume_api_rate_limit(text, text, boolean) from public, anon, authenticated;
revoke all on function public.acquire_audit_concurrency_lease(uuid) from public, anon, authenticated;
revoke all on function public.release_audit_concurrency_lease(uuid) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, text, boolean) to service_role;
grant execute on function public.acquire_audit_concurrency_lease(uuid) to service_role;
grant execute on function public.release_audit_concurrency_lease(uuid) to service_role;

grant select on public.profiles, public.leads, public.website_audits to authenticated;
grant insert, update, delete on public.leads to authenticated;
grant insert on public.website_audits to authenticated;
