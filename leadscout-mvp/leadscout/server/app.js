import express from 'express';

const niches = {
  cafe: { label: 'Cafés', conditions: ['["amenity"="cafe"]'] },
  restaurant: { label: 'Restaurants', conditions: ['["amenity"="restaurant"]', '["amenity"="fast_food"]'] },
  salon: { label: 'Beauty salons', conditions: ['["shop"="hairdresser"]', '["shop"="beauty"]'] },
  gym: { label: 'Gyms', conditions: ['["leisure"="fitness_centre"]', '["leisure"="sports_centre"]'] },
  dental: { label: 'Dental clinics', conditions: ['["amenity"="dentist"]', '["healthcare"="dentist"]'] },
  hotel: { label: 'Hotels', conditions: ['["tourism"="hotel"]', '["tourism"="guest_house"]'] },
  retail: { label: 'Retail shops', conditions: ['["shop"="clothes"]', '["shop"="shoes"]', '["shop"="boutique"]'] },
  bakery: { label: 'Bakeries', conditions: ['["shop"="bakery"]'] },
  realestate: { label: 'Real estate agencies', conditions: ['["office"="estate_agent"]'] },
};

const SEARCH_LIMIT = 10;
const SEARCH_WINDOW_MS = 60_000;
const CACHE_TTL_MS = 30 * 60_000;
const NOMINATIM_INTERVAL_MS = 1_100;

function createRateLimiter() {
  const requests = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const address = req.ip || req.socket.remoteAddress || 'unknown';
    const recent = (requests.get(address) || []).filter((timestamp) => now - timestamp < SEARCH_WINDOW_MS);
    requests.set(address, recent);

    if (recent.length >= SEARCH_LIMIT) {
      res.set('Retry-After', String(Math.ceil((SEARCH_WINDOW_MS - (now - recent[0])) / 1000)));
      return res.status(429).json({ error: 'Search limit reached. Please wait before searching again.' });
    }

    recent.push(now);
    requests.set(address, recent);
    if (requests.size > 1_000) {
      for (const [ip, timestamps] of requests) {
        if (!timestamps.some((timestamp) => now - timestamp < SEARCH_WINDOW_MS)) requests.delete(ip);
      }
    }
    return next();
  };
}

function createCache() {
  const entries = new Map();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (Date.now() - entry.time >= CACHE_TTL_MS) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value) {
      entries.set(key, { time: Date.now(), value });
      if (entries.size > 100) entries.delete(entries.keys().next().value);
    },
  };
}

function createTimedFetch(fetchImpl) {
  return async (url, options = {}, timeout = 22_000) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetchImpl(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

function pick(tags, ...keys) {
  for (const key of keys) {
    if (typeof tags[key] === 'string' && tags[key].trim()) return tags[key].trim();
  }
  return '';
}

function normalizeWebsite(raw) {
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function normalizeElement(element) {
  const tags = element.tags || {};
  const name = pick(tags, 'name', 'brand', 'operator');
  if (!name) return null;

  const address = [
    pick(tags, 'addr:housenumber'),
    pick(tags, 'addr:street'),
    pick(tags, 'addr:city'),
  ].filter(Boolean).join(' ') || pick(tags, 'addr:full');
  const location = element.center || element;

  return {
    id: `${element.type}/${element.id}`,
    name,
    category: pick(tags, 'cuisine', 'shop', 'amenity', 'tourism', 'leisure', 'office', 'healthcare') || 'Business',
    address,
    phone: pick(tags, 'contact:phone', 'phone', 'contact:mobile'),
    email: pick(tags, 'contact:email', 'email'),
    website: normalizeWebsite(pick(tags, 'contact:website', 'website')),
    lat: location.lat ?? null,
    lon: location.lon ?? null,
    source: `https://www.openstreetmap.org/${element.type}/${element.id}`,
  };
}

function parseSearchParameters(query) {
  const location = String(query.location || '').trim();
  const niche = String(query.niche || 'cafe');
  const rawLimit = query.limit === undefined ? 100 : Number(query.limit);
  const rawRadius = query.radius === undefined ? 5_000 : Number(query.radius);

  if (
    location.length < 2 ||
    location.length > 120 ||
    !niches[niche] ||
    !Number.isFinite(rawLimit) ||
    !Number.isFinite(rawRadius)
  ) {
    return null;
  }

  return {
    location,
    niche,
    limit: Math.min(250, Math.max(1, Math.trunc(rawLimit))),
    radius: Math.min(15_000, Math.max(500, Math.trunc(rawRadius))),
  };
}

function createNominatimQueue() {
  let nextRequestAt = 0;
  let queue = Promise.resolve();

  return () => {
    const request = queue.then(async () => {
      const delay = Math.max(0, nextRequestAt - Date.now());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      nextRequestAt = Date.now() + NOMINATIM_INTERVAL_MS;
    });
    queue = request.catch(() => {});
    return request;
  };
}

export function createApp({
  fetchImpl = globalThis.fetch,
  userAgent = process.env.NOMINATIM_USER_AGENT ||
    `LeadScout/1.1 (+https://github.com/gerikah/LeadScout${process.env.NOMINATIM_CONTACT_EMAIL ? `; contact: ${process.env.NOMINATIM_CONTACT_EMAIL}` : ''})`,
  overpassUrl = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
} = {}) {
  const app = express();
  const cache = createCache();
  const timedFetch = createTimedFetch(fetchImpl);
  const limitSearches = createRateLimiter();
  const waitForNominatim = createNominatimQueue();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/health', (req, res) => res.json({ status: 'ok', provider: 'OpenStreetMap Overpass + Nominatim' }));
  app.get('/api/niches', (req, res) => res.json(Object.entries(niches).map(([id, value]) => ({ id, label: value.label }))));
  app.get('/api/search', limitSearches, async (req, res) => {
    const parameters = parseSearchParameters(req.query);
    if (!parameters) return res.status(400).json({ error: 'Choose a valid niche and location.' });

    const { location, niche, limit, radius } = parameters;
    const key = JSON.stringify({ location: location.toLocaleLowerCase(), niche, limit, radius });
    const previous = cache.get(key);
    if (previous) return res.json({ ...previous, cached: true });

    try {
      await waitForNominatim();
      const geo = await timedFetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`,
        {
          headers: {
            'User-Agent': userAgent,
            'Accept': 'application/json',
          },
        },
      );
      if (geo.status === 429) {
        res.set('Retry-After', geo.headers.get('retry-after') || '60');
        return res.status(503).json({ error: 'Location search is rate limited by OpenStreetMap. Please retry later.' });
      }
      if (geo.status >= 500) {
        res.set('Retry-After', geo.headers.get('retry-after') || '60');
        return res.status(503).json({ error: `Location provider is temporarily unavailable (${geo.status}). Please retry later.` });
      }
      if (!geo.ok) throw new Error(`Location provider unavailable (${geo.status})`);

      const matches = await geo.json();
      if (!Array.isArray(matches) || !matches.length) {
        return res.status(404).json({ error: 'Location not found. Try a more specific city, region, or country.' });
      }

      const latitude = Number(matches[0].lat);
      const longitude = Number(matches[0].lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error('Location provider returned invalid coordinates.');
      }

      const clauses = niches[niche].conditions
        .flatMap((condition) => ['node', 'way'].map((type) =>
          `${type}${condition}(around:${radius},${latitude},${longitude});`))
        .join('');
      const overpassQuery = `[out:json][timeout:25];(${clauses});out center ${Math.min(limit * 5, 1000)};`;
      const response = await timedFetch(
        overpassUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent },
          body: new URLSearchParams({ data: overpassQuery }),
        },
        35_000,
      );
      if (response.status === 429) {
        res.set('Retry-After', response.headers.get('retry-after') || '60');
        return res.status(503).json({ error: 'Business data provider is rate limited. Please retry later.' });
      }
      if (response.status === 504) {
        res.set('Retry-After', response.headers.get('retry-after') || '60');
        return res.status(504).json({ error: 'Business data provider timed out. Please retry in a minute or use a smaller radius.' });
      }
      if (response.status >= 500) {
        res.set('Retry-After', response.headers.get('retry-after') || '60');
        return res.status(503).json({ error: `Business data provider is temporarily unavailable (${response.status}). Please retry later.` });
      }
      if (!response.ok) {
        throw new Error(`Business data provider busy (${response.status}). Please retry in a minute.`);
      }

      const result = await response.json();
      if (!Array.isArray(result.elements)) throw new Error('Unexpected response from business data provider.');

      const seen = new Set();
      const leads = [];
      for (const element of result.elements) {
        const lead = normalizeElement(element);
        if (!lead) continue;
        const fingerprint = `${lead.name.toLocaleLowerCase()}|${(lead.address || `${lead.lat},${lead.lon}`).toLocaleLowerCase()}`;
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        leads.push(lead);
        if (leads.length === limit) break;
      }

      const payload = {
        leads,
        location: matches[0].display_name,
        center: { lat: latitude, lon: longitude },
        niche: niches[niche].label,
        provider: 'OpenStreetMap contributors',
        fetchedAt: new Date().toISOString(),
        notice: 'Publicly contributed business details may be missing or outdated. Verify before outreach.',
      };
      cache.set(key, payload);
      return res.json(payload);
    } catch (error) {
      console.error('Search error:', error.message);
      const status = error.name === 'AbortError' ? 504 : 502;
      const message = error.name === 'AbortError'
        ? 'A business data provider timed out. Try again later or use a smaller radius.'
        : error.message || 'Search failed.';
      return res.status(status).json({ error: message });
    }
  });

  return app;
}
