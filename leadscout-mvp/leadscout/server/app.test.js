import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import vercelHandler from '../api/[...path].js';

const geocode = {
  lat: '14.5567949',
  lon: '121.0211226',
  display_name: 'Makati, Metro Manila, Philippines',
};

const elements = [
  { type: 'node', id: 1, lat: 14.55, lon: 121.02, tags: { name: 'North Star Cafe', amenity: 'cafe', phone: '+63 1' } },
  { type: 'way', id: 2, center: { lat: 14.55, lon: 121.02 }, tags: { name: 'North Star Cafe', amenity: 'cafe', phone: '+63 1' } },
  { type: 'node', id: 3, lat: 14.56, lon: 121.03, tags: { amenity: 'cafe' } },
  { type: 'node', id: 4, lat: 14.57, lon: 121.04, tags: { name: 'Second Cafe', amenity: 'cafe', website: 'second.example' } },
];

async function startServer(fetchImpl = async () => new Response('{}'), appOptions = {}) {
  const server = createServer(createApp({
    fetchImpl,
    userAgent: 'LeadScout-test/1.0 (+https://github.com/gerikah/LeadScout)',
    ...appOptions,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function providerFetch(calls, options = {}) {
  return async (url, request) => {
    calls.push({ url, request });
    if (url.includes('nominatim')) {
      return options.geocodeResponse || new Response(JSON.stringify([geocode]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return options.overpassResponse || new Response(JSON.stringify({ elements }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

test('health and niche endpoints respond', async (t) => {
  const app = await startServer();
  t.after(app.close);
  const health = await fetch(`${app.url}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  assert.equal((await (await fetch(`${app.url}/api/niches`)).json()).length, 9);
});

test('Vercel catch-all exports a working Node request handler', async (t) => {
  const server = createServer(vercelHandler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
});

test('website audit endpoint validates requests and returns explicit audit results', async (t) => {
  const auditedUrls = [];
  const app = await startServer(undefined, {
    websiteAuditor: async (url) => {
      auditedUrls.push(url);
      return { status: 'inconclusive', availability: 'unknown', findings: [] };
    },
  });
  t.after(app.close);

  const missing = await fetch(`${app.url}/api/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(missing.status, 400);
  const response = await fetch(`${app.url}/api/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://public.example/' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'inconclusive', availability: 'unknown', findings: [] });
  assert.deepEqual(auditedUrls, ['https://public.example/']);
});

test('website audit endpoint rejects private literal addresses before making requests', async (t) => {
  const app = await startServer();
  t.after(app.close);
  const response = await fetch(`${app.url}/api/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1/admin' }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Private and local/);
});

test('website audit endpoint rate-limits repeated checks per client', async (t) => {
  const app = await startServer(undefined, {
    websiteAuditor: async () => ({ status: 'inconclusive', availability: 'unknown', findings: [] }),
  });
  t.after(app.close);

  for (let request = 0; request < 5; request += 1) {
    const response = await fetch(`${app.url}/api/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://public.example/' }),
    });
    assert.equal(response.status, 200);
  }
  const limited = await fetch(`${app.url}/api/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://public.example/' }),
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('search validates parameters, normalizes records, deduplicates, and applies result limits', async (t) => {
  const calls = [];
  const app = await startServer(providerFetch(calls));
  t.after(app.close);

  const bad = await fetch(`${app.url}/api/search?niche=madeup&location=Makati`);
  assert.equal(bad.status, 400);
  const invalidNumber = await fetch(`${app.url}/api/search?niche=cafe&location=Makati&limit=abc`);
  assert.equal(invalidNumber.status, 400);
  assert.equal(calls.length, 0);

  const response = await fetch(`${app.url}/api/search?niche=cafe&location=Makati&limit=1&radius=500`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.leads.length, 1);
  assert.equal(result.leads[0].id, 'node/1');
  assert.equal(result.leads[0].source, 'https://www.openstreetmap.org/node/1');
  assert.deepEqual(calls.map((call) => new URL(call.url).hostname), [
    'nominatim.openstreetmap.org',
    'overpass-api.de',
  ]);
  assert.equal(calls[0].request.headers['User-Agent'], 'LeadScout-test/1.0 (+https://github.com/gerikah/LeadScout)');
  assert.match(new URLSearchParams(calls[1].request.body).get('data'), /out center 5;/);

  const cached = await fetch(`${app.url}/api/search?niche=cafe&location=Makati&limit=1&radius=500`);
  assert.equal((await cached.json()).cached, true);
  assert.equal(calls.length, 2);
});

test('search clamps out-of-range finite limits and radii', async (t) => {
  const calls = [];
  const app = await startServer(providerFetch(calls));
  t.after(app.close);

  const response = await fetch(`${app.url}/api/search?niche=cafe&location=Makati&limit=999&radius=99999`);
  assert.equal(response.status, 200);
  const query = new URLSearchParams(calls[1].request.body).get('data');
  assert.match(query, /around:15000,/);
  assert.match(query, /out center 1000;/);
});

test('location not found returns a clear 404', async (t) => {
  const app = await startServer(providerFetch([], {
    geocodeResponse: new Response('[]', { status: 200 }),
  }));
  t.after(app.close);
  const response = await fetch(`${app.url}/api/search?niche=cafe&location=NoPlace`);
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /Location not found/);
});

test('upstream 429 is surfaced as a retryable provider error', async (t) => {
  const app = await startServer(providerFetch([], {
    overpassResponse: new Response('{}', { status: 429, headers: { 'Retry-After': '45' } }),
  }));
  t.after(app.close);
  const response = await fetch(`${app.url}/api/search?niche=cafe&location=Makati`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '45');
});

test('upstream 504 is returned as a retryable timeout', async (t) => {
  const app = await startServer(providerFetch([], {
    overpassResponse: new Response('overloaded', { status: 504 }),
  }));
  t.after(app.close);
  const response = await fetch(`${app.url}/api/search?niche=cafe&location=Makati`);
  assert.equal(response.status, 504);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.match((await response.json()).error, /timed out/);
});

test('provider timeouts return a gateway timeout', async (t) => {
  const app = await startServer(async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });
  t.after(app.close);
  const response = await fetch(`${app.url}/api/search?niche=cafe&location=Makati`);
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /timed out/);
});

test('geocoding requests are serialized at least one second apart', async (t) => {
  const geocodeStarts = [];
  const app = await startServer(async (url) => {
    if (url.includes('nominatim')) {
      geocodeStarts.push(Date.now());
      const name = new URL(url).searchParams.get('q');
      return new Response(JSON.stringify([{ ...geocode, display_name: name }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ elements: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  t.after(app.close);

  const searches = await Promise.all([
    fetch(`${app.url}/api/search?niche=cafe&location=First%20City`),
    fetch(`${app.url}/api/search?niche=cafe&location=Second%20City`),
  ]);
  assert.deepEqual(searches.map((response) => response.status), [200, 200]);
  assert.equal(geocodeStarts.length, 2);
  assert.ok(geocodeStarts[1] - geocodeStarts[0] >= 1_000);
});

test('search endpoint enforces per-IP request limits', async (t) => {
  const app = await startServer();
  t.after(app.close);
  for (let request = 0; request < 10; request += 1) {
    const response = await fetch(`${app.url}/api/search?niche=invalid&location=Makati`);
    assert.equal(response.status, 400);
  }
  const limited = await fetch(`${app.url}/api/search?niche=invalid&location=Makati`);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});
