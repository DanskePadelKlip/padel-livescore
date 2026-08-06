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
| **tournamentsoftware adapter** (browser) — NO / GB (LTA) | `src/adapters/tournamentsoftware.js` |
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
  (Playwright). Norway's `ntf.tournamentsoftware.com` and GB/LTA's
  `competitions.lta.org.uk` (LTA Padel British/National Tour incl. Rocks Lane)
  sit behind a cookiewall (auto-cleared) and AJAX-load matches; a proper
  live-scoring system with per-set scores. One adapter, many national instances —
  they share DOM markup and differ only in date language (`locale` per instance).
  Slower + more fragile than JSON, but real data.
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

Live at **https://padelticker.com** (Cloudflare Pages, project `padel-livescore`).

- **Frontend**: static `public/` on Cloudflare Pages — deploys ship CODE.
- **Data — two producers, freshest wins:**
  1. **Primary: the laptop daemon** (`scripts/refresh-loop.js`) — full pipeline,
     adaptive cadence (live → 1 min, upcoming → 10 min, idle → 30 min), deploys
     static data files each cycle. Install as a Windows scheduled task with
     `scripts/install-refresh-task.ps1`.
  2. **Fallback: the free-tier worker** ([`worker/`](worker/index.js)) — a Cron
     Trigger that peeks at the live feed every 2 min. While the daemon is
     producing it stands down (cost: one fetch). When the feed goes stale
     (laptop asleep) it takes over at a gentler cadence (live sources ≈ 5 min,
     one source per firing to fit the free plan's 50-subrequest cap), storing
     snapshots in the existing D1 database. It also owns webhook alerts and Web
     Push while active (`src/webpush.js`, pure WebCrypto — run
     `node scripts/test-webpush.mjs` after touching it).

  `functions/data/*.json.js` serve each `/data/*.json` path from whichever
  producer's copy is fresher (D1 vs the baked static file), so the handoff in
  both directions is automatic — no coordination, no redeploys for data.
- **Manual deploy** (uses a Cloudflare `Pages: Edit` token + account id in your env):
  ```bash
  npx wrangler pages deploy public --project-name padel-livescore --branch main
  ```

### Fallback-worker setup (one-time, free plan, no new resources)

```bash
npx wrangler secret put VAPID_PRIVATE_KEY -c worker/wrangler.toml   # optional: Web Push
npx wrangler secret put ALERT_WEBHOOK_URL -c worker/wrangler.toml   # optional: alerts
npx wrangler deploy -c worker/wrangler.toml
```

Verify: the worker's own URL (printed on deploy) reports whether it's in
standby or acting as fallback producer. With the daemon stopped for ~35 min,
`/data/matches.json` on the site should start carrying `"producer": "worker"`;
start the daemon again and its fresher deploys win back automatically.

Free-plan caveat: the tournamentsoftware source's HTML parsing can exceed the
free 10 ms CPU budget on heavy days — that slot then just stays on its last
good data and retries later; `/api/health` shows it via `lastOkAt`. The
Actions cron in `refresh.yml` remains a third, slow safety net; its
`fetch-live.js` skips alerts/push whenever the worker's data is fresh, so
nothing double-notifies.

**Required GitHub secrets** for the workflow (Settings → Secrets and variables → Actions):
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

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
- ~~**Infra** — fetch job becomes a scheduled worker~~ ✅ done as a fallback tier
  (`worker/` on the free plan + `functions/data/*` freshest-wins serving; the
  laptop daemon stays primary — see "Deploy").
