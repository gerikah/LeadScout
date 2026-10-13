import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createSupabaseServices } from './supabase.js';

async function runMiddleware(middleware, { method = 'GET', authorization } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.get('/check', ...middleware, (_req, res) => res.json({ ok: true }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    return await fetch(`http://127.0.0.1:${address.port}/check`, {
      method,
      headers: authorization ? { Authorization: authorization } : {},
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('without Supabase configuration auth is unavailable and protected APIs deny access', async () => {
  const services = createSupabaseServices({});
  assert.equal(services.authConfigured, false);
  assert.equal(services.sharedConfigured, false);
  const response = await runMiddleware([services.requireUser]);
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /Sign in/);
});

test('server verifies user tokens and applies shared per-user limit responses', async () => {
  const rpcCalls = [];
  const services = createSupabaseServices({
    SUPABASE_URL: 'https://project.example',
    SUPABASE_ANON_KEY: 'public-anon-test-key',
    SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-secret',
  }, {
    clientFactory: (url, key, options) => {
      if (key === 'server-only-test-secret') {
        return {
          rpc: async (name, args) => {
            rpcCalls.push({ name, args });
            return { data: [{ allowed: false, retry_after: 17 }], error: null };
          },
        };
      }
      assert.equal(url, 'https://project.example');
      assert.equal(options.global.headers.Authorization, 'Bearer valid-access-token');
      return {
        auth: {
          getUser: async (token) => ({
            data: { user: token === 'valid-access-token' ? { id: 'user-123', email: 'user@example.test' } : null },
            error: token === 'valid-access-token' ? null : new Error('expired'),
          }),
        },
      };
    },
  });
  assert.equal(services.sharedConfigured, true);
  const limiter = services.createSharedRateLimit('search', (_req, _res, next) => next());
  const response = await runMiddleware([services.optionalUser, limiter], { authorization: 'Bearer valid-access-token' });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '17');
  assert.match((await response.json()).error, /Search limit reached/);
  assert.equal(rpcCalls[0].name, 'consume_api_rate_limit');
  assert.equal(rpcCalls[0].args.p_policy, 'search');
  assert.equal(rpcCalls[0].args.p_authenticated, true);
  assert.match(rpcCalls[0].args.p_identity_hash, /^[a-f0-9]{64}$/);
  assert.equal(rpcCalls[0].args.p_identity_hash.includes('user-123'), false);
});

test('expired bearer tokens cannot access protected lead operations', async () => {
  const services = createSupabaseServices({
    SUPABASE_URL: 'https://project.example',
    SUPABASE_ANON_KEY: 'public-anon-test-key',
  }, {
    clientFactory: () => ({
      auth: { getUser: async () => ({ data: { user: null }, error: new Error('expired') }) },
    }),
  });
  const response = await runMiddleware([services.requireUser], { authorization: 'Bearer expired-token' });
  assert.equal(response.status, 401);
});

test('shared audit concurrency leases can be acquired and released', async () => {
  const calls = [];
  const services = createSupabaseServices({
    SUPABASE_URL: 'https://project.example',
    SUPABASE_ANON_KEY: 'public-anon-test-key',
    SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-secret',
  }, {
    clientFactory: () => ({
      rpc: async (name, args) => {
        calls.push({ name, args });
        return { data: name.startsWith('acquire') ? true : null, error: null };
      },
    }),
  });
  const lease = await services.acquireAuditLease();
  assert.match(lease, /^[0-9a-f-]{36}$/);
  await services.releaseAuditLease(lease);
  assert.deepEqual(calls.map(({ name }) => name), [
    'acquire_audit_concurrency_lease',
    'release_audit_concurrency_lease',
  ]);
});

