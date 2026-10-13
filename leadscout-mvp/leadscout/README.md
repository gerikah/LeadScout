# LeadScout — Open Data Business Lead Finder

LeadScout is a React, Vite, and Express prospecting app using community-contributed OpenStreetMap data. It discovers public business listings and helps organize saved prospects in a browser-local lead pipeline.

## Start locally

Requires Node.js 20+.

```bash
cd leadscout-mvp/leadscout
npm install
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api/*` to the Express API on port 3001.

Run automated tests and the production build:

```bash
npm test
npm run build
```

## Configuration

The search API identifies itself to Nominatim with the LeadScout application and repository in its User-Agent. Optionally configure a contact email for provider correspondence:

```powershell
$env:NOMINATIM_CONTACT_EMAIL = "you@example.com"
npm run dev
```

Set `NOMINATIM_CONTACT_EMAIL` in the hosting provider's environment settings for deployment. `.env.example` documents the variable; the app does not load `.env` files automatically. `NOMINATIM_USER_AGENT` can override the generated User-Agent if a host requires a custom application URL or contact format. `OVERPASS_URL` can select another suitable public Overpass instance.

## Features

- Nine business categories with configurable location, radius (500 m–15 km), and result limit (1–250).
- Nominatim geocoding and Overpass business listings for mapped nodes and ways, with provider timeouts, a 30-minute in-memory result cache, a 1.1-second minimum between geocoder requests per server instance, and a per-instance limit of 10 searches per client IP per minute.
- Publicly listed business names, categories, addresses, phones, emails, websites, and OSM source links.
- Saved business records are stored separately from transient search results and remain available across searches and browser refreshes.
- Outreach status, notes, website/contact/category/location/score/date filters, sorting, pagination, and CSV export for filtered, all saved, and selected leads.
- User-triggered HTTP(S) audits of listed websites, including availability, status, redirects, response latency, HTTPS availability, SEO metadata, headings, image alt-text coverage, and limited embedded-CSS mobile indicators.
- Saved audit history, audit-state filtering, verified-opportunity sorting, and CSV fields for audit results, metadata, and findings.
- Website checks honor robots.txt per visited origin, resolve and pin public IPs for each request, revalidate redirects (maximum three), use standard HTTP(S) ports, cap requests at 5 seconds and audits at 25 seconds, inspect at most 160 KiB, limit concurrency to two per process, and rate-limit each client IP to five audits per minute.
- Stable OpenStreetMap element identifiers prevent duplicate saved records.
- Legacy bookmark IDs and statuses from the previous `leadscout:saved` localStorage format are retained and restored when a matching listing is found in a later search. Since the old format never stored business details or the original save date, those missing fields are explicitly left unavailable until rediscovery.
- CSV export includes source attribution, transparent score factors, and formula-cell escaping for spreadsheet safety.

## Deployment

The frontend and API can be deployed together to Vercel. Set the Vercel project root to `leadscout-mvp/leadscout`; Vite builds to `dist`, and the catch-all Node function in `api/[...path].js` serves the existing Express API routes. `vercel.json` configures a 60-second function duration for public provider calls; confirm that the deployment plan allows this limit.

The serverless cache, search/audit IP rate limiters, and audit concurrency limit are process-local and are not shared between Vercel instances. They do not provide a global quota across serverless instances. For higher-volume multi-user production, use a provider with suitable licensing and configure a shared rate-limiting/cache service before increasing search traffic. The browser-local lead store is per browser/device; it is not a multi-device backup or shared team database.

## Data use and limitations

- OpenStreetMap data is community contributed. **A website missing from a listing is not proof the business has no website.** Phone and email details can be missing, outdated, or incorrect; contact details are not independently verified.
- Scores distinguish listing-completeness points from website-quality opportunity points. Inconclusive or blocked audits do not affect scores. Audit findings reflect bounded automated checks, not a visual design assessment, PageSpeed test, rendered mobile-usability result, or guarantee of business quality.
- Website audits are explicit user actions. They inspect a bounded HTML sample and embedded CSS only; external stylesheets are not fetched. A 401/403/429 response, timeout, robots restriction, or uncertain network failure is marked unknown/inconclusive rather than treated as a website defect.
- Nominatim and public Overpass endpoints are shared, rate-limited community services. Search sparingly and follow their usage policies: <https://operations.osmfoundation.org/policies/nominatim/> and <https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances>. Some relation-only business records are not included.
- Attribution is required: © OpenStreetMap contributors, licensed under ODbL. Database exports can have additional ODbL obligations depending on use: <https://www.openstreetmap.org/copyright>.
- This is a lead research tool, not a Google Maps scraper. It does not bypass provider restrictions, invent contact data, or send automated outreach.
- Supabase can replace the local repository through the `load`, `save`, `update`, `remove`, and `restoreLegacy` repository interface; no Supabase credentials or paid services are currently used.
