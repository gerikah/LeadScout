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

### Supabase authentication and cloud leads

Supabase configuration is optional for local-only use. To enable accounts and cloud sync:

1. Create a Supabase project and review its current plan limits and pricing before enabling it; this code adds no separate paid provider.
2. Apply `supabase/migrations/202610130001_phase4_cloud_leads.sql` in the Supabase SQL Editor, or link the project with the Supabase CLI and run `supabase db push`.
3. Copy the project URL, public anon key, and service-role key from Supabase project settings. Configure `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY` in Vercel. Set `SUPABASE_SERVICE_ROLE_KEY` only as a server-side Vercel environment variable; never prefix it with `VITE_`, put its value in source control, or send it to the browser.
4. For local use, set the same variables in the shell before running the app. Vite reads the `VITE_` variables; the Node server reads the unprefixed server variables. `.env.example` contains empty placeholders and no credentials.
5. Enable email/password in Supabase Auth. Configure the Site URL and allowed redirect URLs for the local origin and production domain (`https://lead-scout-beta-rosy.vercel.app`). Choose whether email confirmation is required in Auth settings.
6. Deploy/rebuild after setting Vite variables because the public project URL and anon key are embedded at frontend build time.

The API verifies bearer tokens with Supabase Auth and performs lead operations with the user's JWT and anon key, so PostgreSQL RLS remains enforced. The browser uses only the anon key. Database rows are per-user; `source_id` is the OpenStreetMap business identifier and is unique per user, while each user's lead has a separate UUID. Website audit history is stored in `website_audits`, linked to its lead and user. Local browser records are not deleted when signing in; the **Import local** action previews full local records and imports in retry-safe batches. Incomplete legacy bookmarks stay local. Existing cloud records are skipped rather than overwritten so retries do not replace cloud notes/status edits.

### Shared API limits and production readiness

Applying the migration and setting `SUPABASE_SERVICE_ROLE_KEY` enables shared database-backed request quotas: unauthenticated searches 10/minute and audits 5/minute; authenticated searches 30/minute and audits 10/minute. A shared PostgreSQL lease limits audits to two concurrent requests, with expired leases cleaned up after their 30-second safety window. The service role is used only server-side for the limited rate/concurrency RPC functions; RLS is enabled and the RPC tables are not accessible to browser roles.

If the Supabase shared-limiter configuration is absent, existing process-local caps remain as a fallback and `/api/health` reports `rateLimitingMode: "per-instance-fallback"`; it is not a global limit. With the credentials present, health reports `rateLimitingMode: "database-configured-not-probed"` and `sharedRateLimitingConfigured: true`—configuration alone does not prove the migration/RPC is installed. If an RPC is unavailable, protected limiter checks fail closed with HTTP 503 rather than silently falling back. After applying the migration, verify that search/audit calls pass their limit checks, `/api/health` reports authentication configured, and authenticated CRUD/RLS works with two separate test accounts before announcing cloud sync as ready. This repository's tests validate API authorization paths and migration policy definitions, but they do not connect to your Supabase project; live RLS and deployment behavior require that manual two-account check.

Rollback: disable auth UI by removing `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then rebuild and deploy. Browser-local records remain available. Back up the database before schema changes; do not drop the new tables as part of an application rollback if they contain user data. Export per-user leads/audit history through an approved backup before deleting a Supabase project.

## Data use and limitations

- OpenStreetMap data is community contributed. **A website missing from a listing is not proof the business has no website.** Phone and email details can be missing, outdated, or incorrect; contact details are not independently verified.
- Scores distinguish listing-completeness points from website-quality opportunity points. Inconclusive or blocked audits do not affect scores. Audit findings reflect bounded automated checks, not a visual design assessment, PageSpeed test, rendered mobile-usability result, or guarantee of business quality.
- Website audits are explicit user actions. They inspect a bounded HTML sample and embedded CSS only; external stylesheets are not fetched. A 401/403/429 response, timeout, robots restriction, or uncertain network failure is marked unknown/inconclusive rather than treated as a website defect.
- Nominatim and public Overpass endpoints are shared, rate-limited community services. Search sparingly and follow their usage policies: <https://operations.osmfoundation.org/policies/nominatim/> and <https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances>. Some relation-only business records are not included.
- Attribution is required: © OpenStreetMap contributors, licensed under ODbL. Database exports can have additional ODbL obligations depending on use: <https://www.openstreetmap.org/copyright>.
- This is a lead research tool, not a Google Maps scraper. It does not bypass provider restrictions, invent contact data, or send automated outreach.
- Supabase cloud sync requires project credentials and the database migration. It adds no separate paid provider, but Supabase project usage may be subject to plan limits or charges.
- Once Supabase is configured, authenticated lead operations use the cloud API and RLS-protected PostgreSQL; signed-out users continue to use the browser-local repository.
