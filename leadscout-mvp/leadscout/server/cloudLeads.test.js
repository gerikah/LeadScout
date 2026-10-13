import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createServer } from 'node:http';
import { createCloudLeadsRouter } from './cloudLeads.js';

class MemoryQuery {
  constructor(store, user, table) {
    this.store = store;
    this.user = user;
    this.table = table;
    this.filters = [];
    this.action = 'select';
    this.singleResult = false;
  }

  select(columns) { this.columns = columns; return this; }
  insert(values) { this.action = 'insert'; this.values = Array.isArray(values) ? values : [values]; return this; }
  upsert(values, options) {
    this.action = 'upsert';
    this.values = Array.isArray(values) ? values : [values];
    this.ignoreDuplicates = options?.ignoreDuplicates;
    return this;
  }
  update(values) { this.action = 'update'; this.values = values; return this; }
  delete() { this.action = 'delete'; return this; }
  eq(field, value) { this.filters.push([field, value]); return this; }
  order() { return this; }
  limit() { return this; }
  single() { this.singleResult = true; return this; }
  maybeSingle() { this.singleResult = true; return this; }
  then(resolve, reject) { return this.execute().then(resolve, reject); }

  async execute() {
    if (this.store.rejectNext) {
      const error = this.store.rejectNext;
      this.store.rejectNext = null;
      throw error;
    }
    const rows = this.store[this.table];
    if (this.action === 'insert' || this.action === 'upsert') {
      for (const value of this.values) {
        if (this.table === 'leads' && rows.some((row) =>
          row.user_id === value.user_id && row.source_id === value.source_id,
        )) {
          return { data: null, error: { code: '23505' } };
        }
        if (this.table === 'website_audits') {
          if (
            value.user_id !== this.user.id ||
            !this.store.leads.some((row) => row.id === value.lead_id && row.user_id === this.user.id)
          ) return { data: null, error: { code: '42501' } };
          if (rows.some((row) => row.lead_id === value.lead_id && row.checked_at === value.checked_at)) {
            if (this.action === 'upsert' && this.ignoreDuplicates) continue;
            return { data: null, error: { code: '23505' } };
          }
        }
        rows.push({ id: randomUUID(), created_at: new Date().toISOString(), ...value });
      }
      const inserted = rows.slice(-this.values.length);
      return { data: this.singleResult ? inserted[0] : inserted, error: null };
    }

    let visible = rows.filter((row) => row.user_id === this.user.id);
    for (const [field, value] of this.filters) visible = visible.filter((row) => row[field] === value);
    if (this.action === 'update') {
      for (const row of visible) Object.assign(row, this.values);
      return { data: this.singleResult ? visible[0] || null : visible, error: null };
    }
    if (this.action === 'delete') {
      const ids = new Set(visible.map((row) => row.id));
      this.store[this.table] = rows.filter((row) => !ids.has(row.id));
      if (this.table === 'leads') {
        this.store.website_audits = this.store.website_audits.filter((row) => !ids.has(row.lead_id));
      }
      return { data: this.singleResult ? visible[0] || null : visible, error: null };
    }
    if (this.table === 'leads' && String(this.columns).includes('website_audits(')) {
      visible = visible.map((row) => ({
        ...row,
        website_audits: this.store.website_audits
          .filter((audit) => audit.lead_id === row.id && audit.user_id === this.user.id)
          .map((audit) => ({ audit_data: audit.audit_data })),
      }));
    }
    return { data: this.singleResult ? visible[0] || null : visible, error: null };
  }
}

async function makeTestApi() {
  const store = { leads: [], website_audits: [] };
  const app = express();
  app.use(express.json());
  const requireUser = (req, res, next) => {
    const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Sign in required.' });
    req.supabaseUser = { id: token };
    req.supabaseClient = { from: (table) => new MemoryQuery(store, req.supabaseUser, table) };
    return next();
  };
  app.use('/api/leads', createCloudLeadsRouter(requireUser));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    store,
    url: `http://127.0.0.1:${server.address().port}/api/leads`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function business(overrides = {}) {
  return {
    id: 'node/42',
    name: 'Harbor Coffee',
    category: 'cafe',
    address: 'Pier Street',
    location: 'Makati',
    website: 'https://example.com/',
    phone: '',
    email: '',
    source: 'https://www.openstreetmap.org/node/42',
    status: 'Follow-up',
    notes: 'Call next week',
    savedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

test('cloud lead API requires a bearer session', async (t) => {
  const api = await makeTestApi();
  t.after(api.close);
  const response = await fetch(api.url);
  assert.equal(response.status, 401);
});

test('cloud lead CRUD, status validation, duplicate prevention, and user isolation', async (t) => {
  const api = await makeTestApi();
  t.after(api.close);
  const userA = { Authorization: 'Bearer user-a', 'Content-Type': 'application/json' };
  const userB = { Authorization: 'Bearer user-b', 'Content-Type': 'application/json' };

  const created = await fetch(api.url, { method: 'POST', headers: userA, body: JSON.stringify({ lead: business() }) });
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.imported, 1);
  const cloudId = createdBody.leads[0].cloudId;

  const repeated = await fetch(api.url, { method: 'POST', headers: userA, body: JSON.stringify({ lead: business() }) });
  assert.equal((await repeated.json()).skipped, 1);
  assert.equal(api.store.leads.length, 1);

  const ownLeads = await fetch(api.url, { headers: userA });
  assert.equal((await ownLeads.json()).leads.length, 1);
  const otherLeads = await fetch(api.url, { headers: userB });
  assert.equal((await otherLeads.json()).leads.length, 0);

  const invalidStatus = await fetch(`${api.url}/${cloudId}`, {
    method: 'PATCH',
    headers: userA,
    body: JSON.stringify({ status: 'admin' }),
  });
  assert.equal(invalidStatus.status, 400);
  const updated = await fetch(`${api.url}/${cloudId}`, {
    method: 'PATCH',
    headers: userA,
    body: JSON.stringify({ status: 'Interested', notes: 'Updated notes' }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).notes, 'Updated notes');

  const hiddenUpdate = await fetch(`${api.url}/${cloudId}`, {
    method: 'PATCH',
    headers: userB,
    body: JSON.stringify({ status: 'Closed' }),
  });
  assert.equal(hiddenUpdate.status, 404);
  assert.equal(api.store.leads[0].status, 'Interested');

  const hiddenDelete = await fetch(`${api.url}/${cloudId}`, { method: 'DELETE', headers: userB });
  assert.equal(hiddenDelete.status, 404);
  const removed = await fetch(`${api.url}/${cloudId}`, { method: 'DELETE', headers: userA });
  assert.equal(removed.status, 200);
  assert.equal(api.store.leads.length, 0);
});

test('cloud audit history is retained and repeated local imports remain safe', async (t) => {
  const api = await makeTestApi();
  t.after(api.close);
  const headers = { Authorization: 'Bearer user-a', 'Content-Type': 'application/json' };
  const audit = {
    status: 'completed',
    checkedAt: '2026-10-02T12:00:00.000Z',
    availability: 'available',
    findings: [{ code: 'missing-description', confidence: 'verified' }],
  };
  const olderAudit = {
    ...audit,
    checkedAt: '2026-10-01T12:00:00.000Z',
    findings: [{ code: 'missing-title', confidence: 'verified' }],
  };
  const first = await fetch(api.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ lead: business({ websiteAudit: audit, auditHistory: [olderAudit, audit] }) }),
  });
  const cloudId = (await first.json()).leads[0].cloudId;
  assert.equal(api.store.website_audits.length, 2);
  assert.equal(api.store.website_audits.some((row) => row.audit_data.checkedAt === olderAudit.checkedAt), true);

  const repeated = await fetch(api.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ lead: business({ websiteAudit: audit, auditHistory: [olderAudit, audit] }) }),
  });
  assert.equal((await repeated.json()).skipped, 1);
  assert.equal(api.store.website_audits.length, 2);

  const history = await fetch(api.url, { headers });
  const loaded = (await history.json()).leads[0];
  assert.equal(loaded.cloudId, cloudId);
  assert.equal(loaded.websiteAudit.checkedAt, audit.checkedAt);
  assert.equal(loaded.auditHistory.length, 2);

  const invalidAudit = await fetch(`${api.url}/${cloudId}/audits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ audit: { status: 'completed', checkedAt: 'bad', findings: [] } }),
  });
  assert.equal(invalidAudit.status, 400);
});

test('cloud lead import rejects invalid website URLs and handles rejected database calls safely', async (t) => {
  const api = await makeTestApi();
  t.after(api.close);
  const headers = { Authorization: '******', 'Content-Type': 'application/json' };
  const invalid = await fetch(api.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ lead: business({ website: 'javascript:alert(1)' }) }),
  });
  assert.equal(invalid.status, 400);

  api.store.rejectNext = new Error('internal database details');
  const originalError = console.error;
  console.error = () => {};
  try {
    const failed = await fetch(api.url, { headers });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('retry-after'), '3');
    assert.doesNotMatch(await failed.text(), /internal database details/);
  } finally {
    console.error = originalError;
  }
});
