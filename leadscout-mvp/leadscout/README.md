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
- Stable OpenStreetMap element identifiers prevent duplicate saved records.
- Legacy bookmark IDs and statuses from the previous `leadscout:saved` localStorage format are retained and restored when a matching listing is found in a later search. Since the old format never stored business details or the original save date, those missing fields are explicitly left unavailable until rediscovery.
- CSV export includes source attribution, transparent score factors, and formula-cell escaping for spreadsheet safety.

## Deployment

The frontend and API can be deployed together to Vercel. Set the Vercel project root to `leadscout-mvp/leadscout`; Vite builds to `dist`, and the catch-all Node function in `api/[...path].js` serves the existing Express API routes. `vercel.json` configures a 60-second function duration for public provider calls; confirm that the deployment plan allows this limit.

The serverless cache and IP rate limiter are process-local and are not shared between Vercel instances. They reduce repeated requests within an instance but are not a global traffic quota. For higher-volume multi-user production, use a provider with suitable licensing and configure a shared rate-limiting/cache service before increasing search traffic. The browser-local lead store is per browser/device; it is not a multi-device backup or shared team database.

## Data use and limitations

- OpenStreetMap data is community contributed. **A website missing from a listing is not proof the business has no website.** Phone and email details can be missing, outdated, or incorrect; contact details are not independently verified.
- Opportunity scores are transparent listing-gap signals, not assessments of business quality. No website HTTP checks, mobile checks, PageSpeed tests, or SEO audits are performed yet.
- Nominatim and public Overpass endpoints are shared, rate-limited community services. Search sparingly and follow their usage policies: <https://operations.osmfoundation.org/policies/nominatim/> and <https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances>. Some relation-only business records are not included.
- Attribution is required: © OpenStreetMap contributors, licensed under ODbL. Database exports can have additional ODbL obligations depending on use: <https://www.openstreetmap.org/copyright>.
- This is a lead research tool, not a Google Maps scraper. It does not bypass provider restrictions, invent contact data, or send automated outreach.
- Supabase can replace the local repository through the `load`, `save`, `update`, `remove`, and `restoreLegacy` repository interface; no Supabase credentials or paid services are currently used.
