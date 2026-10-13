begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('90000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'rls-user-a@leadscout.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('90000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'rls-user-b@leadscout.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());

insert into public.leads (
  id, user_id, source_id, name
) values
  ('91000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'node/910001', 'User A business'),
  ('91000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000002', 'node/910002', 'User B business');

set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-000000000001', true);

do $$
declare visible_count integer;
begin
  select count(*) into visible_count from public.leads;
  if visible_count <> 1 then raise exception 'RLS isolation failed: User A can see % leads', visible_count; end if;

  update public.leads set notes = 'cross-user mutation attempt'
  where id = '91000000-0000-4000-8000-000000000002';
  if found then raise exception 'RLS isolation failed: User A updated User B lead'; end if;

  delete from public.leads where id = '91000000-0000-4000-8000-000000000002';
  if found then raise exception 'RLS isolation failed: User A deleted User B lead'; end if;

  begin
    insert into public.leads (user_id, source_id, name)
    values ('90000000-0000-4000-8000-000000000002', 'node/910003', 'Cross-user insert attempt');
    raise exception 'RLS isolation failed: User A inserted a lead for User B';
  exception when insufficient_privilege then
    null;
  end;

  insert into public.website_audits (user_id, lead_id, audit_data, checked_at)
  values (
    '90000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    '{"status":"completed","checkedAt":"2026-10-01T00:00:00Z","availability":"available","findings":[]}',
    '2026-10-01T00:00:00Z'
  );

  begin
    insert into public.website_audits (user_id, lead_id, audit_data, checked_at)
    values (
      '90000000-0000-4000-8000-000000000002',
      '91000000-0000-4000-8000-000000000002',
      '{"status":"completed","checkedAt":"2026-10-01T00:00:00Z","availability":"available","findings":[]}',
      '2026-10-01T00:00:00Z'
    );
    raise exception 'RLS isolation failed: User A inserted an audit for User B';
  exception when insufficient_privilege then
    null;
  end;

  select count(*) into visible_count from public.website_audits;
  if visible_count <> 1 then raise exception 'RLS isolation failed: unexpected audit visibility'; end if;
end;
$$;

rollback;
