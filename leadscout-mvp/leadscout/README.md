# LeadScout — Open Data Business Lead Finder

A runnable lead prospecting MVP built with React, Vite, Express and OpenStreetMap. It searches real local business listings, highlights missing website listings, captures publicly contributed phones/emails, tracks your outreach pipeline locally and exports filtered leads to CSV.

## Start

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. The API runs on **http://localhost:3001**.

For deployment, host the Express API as a running Node service and the built Vite client (`npm run build`, output `dist/`) as a static site. Configure your hosting proxy so `/api/*` forwards to Express. Vercel static-only hosting will **not** run the server as packaged.

## Features

- 9 niche categories and configurable location, radius (1.5–15 km), and maximum results (25–250).
- Uses Nominatim geocoding and OpenStreetMap's Overpass API, no API key.
- Shows publicly listed name, approximate OSM address, phone, email, website, and original OSM source link.
- Deduplicates by name + address / coordinates.
- Scores opportunities based on missing OSM website/contact fields (not a website quality or speed audit).
- Filters, searchable and paginated results, saved prospects, outreach status, CSV export.
- Saves bookmarked records and statuses in the same browser using localStorage. Search results are transient and must be re-searched; use CSV for permanent export.

## Important limitations

- OpenStreetMap is community data: **unlisted website ≠ business has no website**. Emails and phones may be absent, out-of-date or wrong.
- Public Overpass and Nominatim endpoints are shared, rate-limited community services and may fail or time out. Avoid repeated bulk searching or high-volume commercial use. For production, set up your own infrastructure or use a commercial data provider with suitable licensing.
- Attribution required: © OpenStreetMap contributors, licensed under ODbL. Depending on use, database exports can carry ODbL obligations. See https://www.openstreetmap.org/copyright.
- This is a lead research tool, **not** a Google Maps scraper. It does not evade provider restrictions, gather private information, or send automated outreach.
- Opportunity scores are heuristics and deliberately do not claim to identify slow websites, bad design, or verified leads.
- For sustained usage, configure a valid, descriptive identifying User-Agent and contact address for the geocoding provider in `server/index.js`; the included placeholder must be replaced before public deployment. Follow https://operations.osmfoundation.org/policies/nominatim/.

## Possible production upgrades

Supabase user accounts and durable storage; compliant commercial data provider; opt-in/PageSpeed Insights checks of owned or publicly accessible websites; Google Sheets integration via OAuth; team pipeline; responsible email verification and outreach drafting.
