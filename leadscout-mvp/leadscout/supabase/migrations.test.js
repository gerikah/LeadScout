import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('./migrations/202610130001_phase4_cloud_leads.sql', import.meta.url);

test('cloud migration defines normalized user-owned lead and audit tables', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const table of ['profiles', 'leads', 'website_audits', 'api_rate_limit_windows', 'audit_concurrency_leases']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
  }
  assert.match(sql, /unique \(user_id, source_id\)/);
  assert.match(sql, /references auth\.users\(id\) on delete cascade/);
  assert.match(sql, /references public\.leads\(id, user_id\) on delete cascade/);
  assert.match(sql, /check \(status in \('New', 'To Contact', 'Contacted', 'Follow-up', 'Interested', 'Not Interested', 'Closed'\)\)/);
  assert.match(sql, /create index if not exists leads_user_saved_idx/);
});

test('migration enables owner-scoped RLS and reserves shared-limit RPCs for service role', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const table of ['profiles', 'leads', 'website_audits', 'api_rate_limit_windows', 'audit_concurrency_leases']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(sql, /create policy "Users read own leads"[\s\S]*?auth\.uid\(\).*?user_id/s);
  assert.match(sql, /create policy "Users update own leads"[\s\S]*?auth\.uid\(\).*?with check/s);
  assert.match(sql, /create policy "Users add own website audits"[\s\S]*?auth\.uid\(\)[\s\S]*?leads\.user_id/s);
  assert.match(sql, /revoke all on function public\.consume_api_rate_limit\(text, text, boolean\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.consume_api_rate_limit\(text, text, boolean\) to service_role/);
  assert.match(sql, /revoke all on public\.profiles, public\.leads, public\.website_audits from anon, public/);
  assert.match(sql, /grant select on public\.profiles, public\.leads, public\.website_audits to authenticated/);
  assert.match(sql, /grant insert on public\.website_audits to authenticated/);
  assert.match(sql, /pg_advisory_xact_lock/);
});
