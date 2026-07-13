# 🎾 PadelTicker

**Live padel scores** from around the world — live / upcoming / final matches from
**every** federation, aggregated through one normalized adapter layer. Not a
pro-tour-only site (that space is crowded); the wedge is national-federation +
amateur coverage across countries, which nobody else does.

Live at **https://padel-livescore.pages.dev** (custom domain **padelticker.live** to come).
Handles: `@padelticker` on Instagram / TikTok / X / YouTube.

## Architecture

```
adapters/*  ─►  normalize ─►  aggregate ─►  matches.json  ─►  livescore UI
(one per source)  (schema.js)   (merge+sort)   (public/data)     (public/)
```

The **only** contract is the normalized match shape in [`src/schema.js`](src/schema.js).
Every adapter emits it; nothing downstream knows about any source's quirks.
Adding a country = one new adapter (or, for RankedIn federations, one new row).

| Piece | File |
| --- | --- |
| Normalized match shape | `src/schema.js` |
| RankedIn API HTTP layer | `src/http.js` |
| Headless-browser layer (Playwright) | `src/browser.js` |
| Federation / instance registry | `src/federations.js` |
| **RankedIn adapter** (JSON) — DK/SE/DE/CZ | `src/adapters/rankedin.js` |
| **tournamentsoftware adapter** (browser) — NO | `src/adapters/tournamentsoftware.js` |
| **FIP adapter** (widget HTML) — Premier/FIP tour | `src/adapters/fip.js` |
| Aggregate + sort + dedupe | `src/aggregate.js` |
| Fetch job (→ matches.json) | `scripts/fetch-live.js` |
| Static server | `scripts/serve.js` |
| Livescore UI | `public/index.html`, `public/app.js` |

### The UI (P2)
A dependency-free vanilla livescore front-end (`public/`):
- **Live Now** section pinned on top (pulsing), with a live count on the Live tab
- Filters: status tabs (All / Live / Upcoming / Final), country chips, player/tournament search
- Matches grouped by tournament in **collapsible** groups (auto-expands live + the first;
  each group caps at 20 rows with "show more") — keeps the ~580-match DOM light
- Tap a match → inline detail: set-by-set grid, class/round/court/start, source link
- **Auto-refresh**: polls `data/matches.json` every 25s, flashing changed scores
- Theme-aware (light/dark) with a manual toggle; responsive down to mobile

### Three classes of source
- **JSON APIs** (RankedIn) — clean fetch-and-parse, fast, robust. DK/SE/DE/CZ.
- **JS-only web apps** (tournamentsoftware) — no API; rendered via `src/browser.js`
  (Playwright). Norway's `ntf.tournamentsoftware.com` sits behind a cookiewall
  (auto-cleared) and AJAX-loads matches; a proper live-scoring system with per-set
  scores. Slower + more fragile than JSON, but real data.
- **Server-rendered widget HTML** (FIP/Premier) — padelfip.com embeds a
  `matchscorerlive.com` widget. Discover in-play tournaments via padelfip's
  WordPress REST (`?orderby=modified`), read each event page for its `idEvent`
  (→ `FIP-{year}-{idEvent}`), then fetch the Order-of-Play widget per tournament
  day (completed + live + upcoming in one page). HTML is fetched plainly (with a
  `Referer: padelfip.com` header, or it 403s) and parsed via the shared browser's
  `setContent`. Covers Premier P1/P2 + FIP Bronze/Silver/Gold worldwide.

> **Finland is intentionally NOT included.** Padelution (padel.fi) is Livewire with
> no API, and — the real blocker — typical Finnish events publish only final
> **standings**, not match scores, with no live feed. Nothing for a livescore to
> show. See `NON_RANKEDIN` in `src/federations.js`.

## Run

Requires Node ≥ 18 (uses global `fetch`). One-time setup for the browser layer:

```bash
npm install                         # installs playwright
npx playwright install chromium     # downloads the headless browser (~once)
```

Then:

```bash
node scripts/fetch-live.js          # pull today's matches -> public/data/matches.json
node scripts/fetch-live.js 2026-07-12   # a specific day
node scripts/serve.js               # view at http://localhost:8787
# or: npm run dev                   # fetch + serve
```

## RankedIn adapter, how it works

1. `GetOrganisationEventsAsync(org)` → tournaments with start/end dates.
2. Keep tournaments whose date range covers the target day.
3. `GetMatchesSectionAsync(eventId)` → every match in that tournament.
4. Normalize teams, score, court, status.

All endpoints are anonymous but require a browser `User-Agent` + `Referer`
(handled in `src/http.js`). Verified org-agnostic on 2026-07-12.

### Known Phase-0 limitation — live-state calibration
RankedIn encodes match state as an int enum (`raw.state`). We've confirmed
`6 = played/final`; the exact **live** value needs a tournament in progress to
pin down. Until then `mapStatus()` derives status from the data (played? partial
score present?) and preserves `raw.state` so we can calibrate the enum the first
time we catch a live match.

## Deploy

Live at **https://padel-livescore.pages.dev** (Cloudflare Pages, project `padel-livescore`).

- **Frontend**: static `public/` on Cloudflare Pages. The UI polls `data/matches.json`,
  which is a static file baked into each deployment.
- **Data refresh**: `.github/workflows/refresh.yml` runs the Playwright fetch on a cron
  and redeploys `public/` (with a fresh `matches.json`) via `wrangler pages deploy`.
- **Manual deploy** (uses a Cloudflare `Pages: Edit` token + account id in your env):
  ```bash
  node scripts/fetch-live.js
  npx wrangler pages deploy public --project-name padel-livescore --branch main
  ```

**Required GitHub secrets** for the workflow (Settings → Secrets and variables → Actions):
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

**⚠️ Actions-minutes cost:** the fetch needs a real browser, so each run is ~4 min.
On a **private** repo GitHub gives ~2000 free min/month — any useful cadence blows past
that. Options: make the repo **public** (unlimited free minutes; the site + data are
public anyway and no secrets live in the code), use a **self-hosted runner**, run the
fetch+deploy from your **own machine on a schedule**, or accept a low cadence / pay for
minutes.

## Roadmap

- **P1** — more RankedIn federations. NB: `GetOrganisationEventsAsync` only returns
  data for federations that host *centrally* (DK/SE/DE/CZ). Decentralized ones
  (AT/EE/CH/HR…) need a country-level event-discovery endpoint (TODO).
- ~~**P2** — real livescore UX~~ ✅ done (see "The UI" above). Remaining polish:
  tournamentsoftware date-selector should fetch *today's* day view (backend), and
  true point-by-point live once a live match is available to calibrate against.
- ~~**P3** — FIP/Premier adapter~~ ✅ done (`src/adapters/fip.js`, via matchscorerlive).
  Next source: France (Ten'Up/FFT — likely another browser adapter on `src/browser.js`).
  FIP polish: parse the "Starting at 9:00 AM" schedule text into a real start time.
- **Infra** — Cloudflare Pages + Functions; fetch job becomes a scheduled worker.
  Browser adapters need a Playwright-capable runner (or a small separate service).
