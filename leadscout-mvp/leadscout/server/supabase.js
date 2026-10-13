import { createClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'node:crypto';

function configuration(env = process.env) {
  return {
    url: env.SUPABASE_URL || env.VITE_SUPABASE_URL || '',
    anonKey: env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || '',
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
  };
}

export function createSupabaseServices(env = process.env, { clientFactory = createClient } = {}) {
  const config = configuration(env);
  const authConfigured = Boolean(config.url && config.anonKey);
  const sharedConfigured = Boolean(authConfigured && config.serviceRoleKey);
  const serviceClient = sharedConfigured
    ? clientFactory(config.url, config.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    : null;

  function getAccessToken(req) {
    const value = req.get('authorization') || '';
    const match = /^Bearer\s+([^\s]+)$/i.exec(value);
    return match?.[1] || '';
  }

  async function authenticate(req) {
    if (!authConfigured) return { user: null, client: null };
    const token = getAccessToken(req);
    if (!token) return { user: null, client: null };
    const client = clientFactory(config.url, config.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) return { user: null, client: null };
    return { user: data.user, client };
  }

  function optionalUser(req, res, next) {
    authenticate(req).then(({ user, client }) => {
      req.supabaseUser = user;
      req.supabaseClient = client;
      next();
    }).catch((error) => {
      console.error('Supabase authentication verification failed:', error);
      res.status(503).json({ error: 'Authentication service is temporarily unavailable.' });
    });
  }

  function requireUser(req, res, next) {
    optionalUser(req, res, () => {
      if (!req.supabaseUser) return res.status(401).json({ error: 'Sign in to access saved leads.' });
      return next();
    });
  }

  function identityHash(req, authenticated) {
    const identity = authenticated
      ? `user:${req.supabaseUser.id}`
      : `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    return createHmac('sha256', config.serviceRoleKey).update(identity).digest('hex');
  }

  function createSharedRateLimit(policy, fallbackLimiter) {
    return async (req, res, next) => {
      if (!serviceClient) return fallbackLimiter(req, res, next);
      try {
        const { data, error } = await serviceClient.rpc('consume_api_rate_limit', {
          p_policy: policy,
          p_identity_hash: identityHash(req, Boolean(req.supabaseUser)),
          p_authenticated: Boolean(req.supabaseUser),
        });
        if (error) throw error;
        const limit = Array.isArray(data) ? data[0] : data;
        if (!limit?.allowed) {
          const retryAfter = Math.max(1, Number(limit?.retry_after) || 60);
          res.set('Retry-After', String(retryAfter));
          return res.status(429).json({ error: `${policy === 'search' ? 'Search' : 'Website audit'} limit reached. Please wait before retrying.` });
        }
        return next();
      } catch (error) {
        console.error('Shared rate limit check failed:', error);
        return res.status(503).json({ error: 'Shared request protection is temporarily unavailable. Please retry shortly.' });
      }
    };
  }

  async function acquireAuditLease() {
    if (!serviceClient) return null;
    const leaseId = randomUUID();
    const { data, error } = await serviceClient.rpc('acquire_audit_concurrency_lease', {
      p_lease_id: leaseId,
    });
    if (error) throw error;
    return data ? leaseId : '';
  }

  async function releaseAuditLease(leaseId) {
    if (!serviceClient || !leaseId) return;
    const { error } = await serviceClient.rpc('release_audit_concurrency_lease', {
      p_lease_id: leaseId,
    });
    if (error) console.error('Could not release shared audit concurrency lease:', error);
  }

  return {
    authConfigured,
    sharedConfigured,
    optionalUser,
    requireUser,
    createSharedRateLimit,
    acquireAuditLease,
    releaseAuditLease,
  };
}
