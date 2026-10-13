import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWebsiteAuditor,
  extractWebsiteMetadata,
  normalizeAuditUrl,
} from './websiteAudit.js';

const PUBLIC_ADDRESS = '93.184.216.34';

function response(status, body = '', headers = {}) {
  return { status, body, headers, truncated: false };
}

function htmlPage({
  title = 'Local business',
  description = 'A local business.',
  viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">',
  extra = '',
} = {}) {
  return `<!doctype html><html><head><title>${title}</title><meta name="description" content="${description}">${viewport}<link rel="canonical" href="/canonical">${extra}<meta property="og:title" content="A preview"></head><body><h1>Welcome</h1><h2>Services</h2><img src="/one.png" alt="Storefront"><img src="/two.png"></body></html>`;
}

function createMockAuditor(requestImpl, overrides = {}) {
  return createWebsiteAuditor({
    resolver: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    requestImpl,
    ...overrides,
  });
}

test('normalizes valid public HTTP(S) URLs and rejects unsafe URL forms', () => {
  assert.equal(normalizeAuditUrl('https://example.com/path#fragment').href, 'https://example.com/path');
  assert.equal(normalizeAuditUrl('example.com/path').href, 'https://example.com/path');
  for (const url of [
    'ftp://example.com/',
    'http://user:password@example.com/',
    'https://example.com:8443/',
    'http://localhost/',
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://service.local/',
    'http://service.internal/',
    'http://service.test/',
  ]) {
    assert.throws(() => normalizeAuditUrl(url), /public|Private|standard ports/);
  }
});

test('rejects private DNS answers before issuing any outbound request', async () => {
  let requests = 0;
  const auditor = createWebsiteAuditor({
    resolver: async () => [{ address: '10.20.30.40', family: 4 }],
    requestImpl: async () => { requests += 1; return response(200); },
  });

  await assert.rejects(auditor('https://public.example/'), /private or unsupported/);
  assert.equal(requests, 0);
});

test('follows a safe redirect and records its status and destination', async () => {
  const requested = [];
  const auditor = createMockAuditor(async (url) => {
    requested.push(url.href);
    if (url.pathname === '/robots.txt') return response(404);
    if (url.hostname === 'example.com') return response(302, '', { location: 'https://www.example.com/home' });
    return response(200, htmlPage(), { 'content-type': 'text/html; charset=utf-8' });
  });

  const result = await auditor('https://example.com/');
  assert.equal(result.availability, 'available');
  assert.equal(result.status, 'completed');
  assert.equal(result.finalUrl, 'https://www.example.com/home');
  assert.deepEqual(result.redirects.map(({ status, to }) => ({ status, to })), [
    { status: 302, to: 'https://www.example.com/home' },
  ]);
  assert.ok(requested.includes('https://www.example.com/robots.txt'));
  assert.ok(requested.includes('https://www.example.com/home'));
});

test('a redirect to a private address is rejected before the private request', async () => {
  const requested = [];
  const auditor = createMockAuditor(async (url) => {
    requested.push(url.href);
    if (url.pathname === '/robots.txt') return response(404);
    return response(302, '', { location: 'http://127.0.0.1/admin' });
  });

  const result = await auditor('https://example.com/');
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.availability, 'unknown');
  assert.match(result.message, /could not be checked conclusively/);
  assert.ok(requested.every((url) => !url.includes('127.0.0.1')));
});

test('re-resolves every redirect host and refuses private DNS answers', async () => {
  const requested = [];
  const auditor = createWebsiteAuditor({
    resolver: async (hostname) => [{
      address: hostname === 'internal.example' ? '192.168.1.10' : PUBLIC_ADDRESS,
      family: 4,
    }],
    requestImpl: async (url) => {
      requested.push(url.href);
      if (url.pathname === '/robots.txt') return response(404);
      return response(302, '', { location: 'https://internal.example/private' });
    },
  });

  await assert.rejects(auditor('https://example.com/'), /private or unsupported/);
  assert.ok(requested.every((url) => !url.includes('internal.example')));
});

test('does not fetch a page when a robots redirect cannot be verified', async () => {
  const requested = [];
  const auditor = createMockAuditor(async (url) => {
    requested.push(url.href);
    if (url.pathname === '/robots.txt') return response(302);
    return response(200, htmlPage(), { 'content-type': 'text/html' });
  });

  const result = await auditor('https://example.com/');
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.availability, 'unknown');
  assert.match(result.message, /robots\.txt policy could not be verified/);
  assert.deepEqual(requested, ['https://example.com/robots.txt']);
});

test('connection failures, timeouts, blocked responses, and HTTP errors are classified explicitly', async () => {
  const refused = createMockAuditor(async (url) => {
    if (url.pathname === '/robots.txt') return response(404);
    const error = new Error('connection refused');
    error.code = 'ECONNREFUSED';
    throw error;
  });
  const refusedResult = await refused('https://example.com/');
  assert.equal(refusedResult.status, 'completed');
  assert.equal(refusedResult.availability, 'unavailable');
  assert.equal(refusedResult.findings[0].code, 'website-unavailable');

  const timeout = createMockAuditor(async () => {
    const error = new Error('timed out');
    error.code = 'ETIMEDOUT';
    throw error;
  });
  const timeoutResult = await timeout('https://example.com/');
  assert.equal(timeoutResult.status, 'inconclusive');
  assert.equal(timeoutResult.availability, 'unknown');
  assert.match(timeoutResult.message, /timed out/);

  const blocked = createMockAuditor(async (url) => (
    url.pathname === '/robots.txt'
      ? response(404)
      : response(403, 'Automated access denied', { 'content-type': 'text/html' })
  ));
  const blockedResult = await blocked('https://example.com/');
  assert.equal(blockedResult.status, 'inconclusive');
  assert.equal(blockedResult.availability, 'unknown');
  assert.match(blockedResult.message, /automated access may be restricted/);

  const notFound = createMockAuditor(async (url) => (
    url.pathname === '/robots.txt'
      ? response(404)
      : response(404, 'Not found', { 'content-type': 'text/html' })
  ));
  const notFoundResult = await notFound('https://example.com/');
  assert.equal(notFoundResult.status, 'completed');
  assert.equal(notFoundResult.availability, 'unavailable');
  assert.equal(notFoundResult.httpStatus, 404);
});

test('robots.txt restrictions prevent page requests and are not treated as website failures', async () => {
  const requested = [];
  const auditor = createMockAuditor(async (url) => {
    requested.push(url.pathname);
    if (url.pathname === '/robots.txt') return response(200, 'User-agent: *\nDisallow: /private');
    return response(200, htmlPage(), { 'content-type': 'text/html' });
  });

  const result = await auditor('https://example.com/private/home');
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.availability, 'unknown');
  assert.match(result.message, /robots.txt disallows/);
  assert.deepEqual(requested, ['/robots.txt']);
});

test('robots end anchors enforce exact path matching', async () => {
  const requested = [];
  const auditor = createMockAuditor(async (url) => {
    requested.push(url.pathname);
    if (url.pathname === '/robots.txt') return response(200, 'User-agent: *\nDisallow: /private$');
    return response(200, htmlPage(), { 'content-type': 'text/html' });
  });

  const exact = await auditor('https://example.com/private');
  assert.equal(exact.status, 'inconclusive');
  assert.match(exact.message, /robots\.txt disallows/);
  assert.deepEqual(requested, ['/robots.txt']);

  requested.length = 0;
  const nested = await auditor('https://example.com/private/page');
  assert.equal(nested.status, 'completed');
  assert.deepEqual(requested, ['/robots.txt', '/private/page']);
});

test('an HTTP site receives a separate HTTPS availability probe', async () => {
  const requested = [];
  const auditor = createMockAuditor(async (url, _addresses, options) => {
    requested.push({ url: url.href, method: options.method });
    if (url.pathname === '/robots.txt') return response(404);
    return response(200, htmlPage(), { 'content-type': 'text/html' });
  });

  const result = await auditor('http://example.com/');
  assert.equal(result.availability, 'available');
  assert.equal(result.https.status, 'available');
  assert.ok(requested.some(({ url, method }) => url === 'https://example.com/' && method === 'HEAD'));
});

test('metadata extraction reports SEO, headings, Open Graph, image alt, and mobile indicators', () => {
  const metadata = extractWebsiteMetadata(
    '<html><head><title>Crème &amp; Co</title><meta name="description" content="Local bakery"><meta name="viewport" content="width=device-width"><link rel="canonical" href="/shop"><meta property="og:title" content="Preview"></head><style>@media(max-width:700px){body{width:1200px;flex-wrap:wrap}}</style><body><h1>Welcome</h1><h2>Menu</h2><img alt="Bread"><img></body></html>',
    new URL('https://example.com/'),
  );
  assert.equal(metadata.title, 'Crème & Co');
  assert.equal(metadata.description, 'Local bakery');
  assert.equal(metadata.viewport, true);
  assert.equal(metadata.canonical, 'https://example.com/shop');
  assert.equal(metadata.openGraph.title, 'Preview');
  assert.deepEqual(metadata.headings, { h1: 1, h2: 1, h3: 0 });
  assert.deepEqual(metadata.imageAlt, { total: 2, withAlt: 1, coveragePercent: 50 });
  assert.ok(metadata.mobile.responsiveIndicators.some(({ signal }) => signal === 'media-query'));
  assert.ok(metadata.mobile.fixedWidthIndicators.length);
});

test('incomplete HTML samples do not create false missing-metadata score findings', async () => {
  const auditor = createMockAuditor(async (url) => {
    if (url.pathname === '/robots.txt') return response(404);
    return {
      ...response(206, '<html><head><title>Partial response</title>'),
      headers: { 'content-type': 'text/html' },
      truncated: true,
    };
  });

  const result = await auditor('https://example.com/');
  assert.equal(result.metadata.sampled, true);
  assert.ok(result.findings.some(({ code }) => code === 'incomplete-head-sample'));
  assert.ok(!result.findings.some(({ code }) => ['missing-title', 'missing-description', 'missing-viewport'].includes(code)));
});

test('concurrent audits are capped and excess work fails with a retryable response', async () => {
  let releaseRobots;
  const waiting = new Promise((resolve) => { releaseRobots = resolve; });
  const auditor = createMockAuditor(async (url) => {
    if (url.pathname === '/robots.txt') await waiting;
    return url.pathname === '/robots.txt'
      ? response(404)
      : response(200, htmlPage(), { 'content-type': 'text/html' });
  }, { maxConcurrent: 1 });

  const first = auditor('https://example.com/');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(auditor('https://example.com/other'), (error) => error.statusCode === 503);
  releaseRobots();
  assert.equal((await first).availability, 'available');
});
