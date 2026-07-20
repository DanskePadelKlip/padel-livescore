// Self-pacing refresh daemon: fetch → (deploy) → sleep → repeat, where the
// sleep ADAPTS to what's on. While any match is live it refreshes ~every minute
// so the site is genuinely live; when nothing is happening it backs off to keep
// cost/effort near zero. This is the natural fit for "live when live, lazy when
// idle" — better than a fixed cron.
//
//   # local only (refresh matches.json, no deploy):
//   node scripts/refresh-loop.js
//
//   # with deploy (PowerShell, reusing your Cloudflare Pages token):
//   . ..\danskepadelklip-site\deploy.config.ps1 ; node scripts/refresh-loop.js
//
// Set REFRESH_DEPLOY=0 to force local-only even when the token is present.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { aggregate } from "../src/aggregate.js";
import { fetchRankings } from "../src/rankings.js";
import { attachSourceHistory } from "../src/health-history.js";
import { refreshCalendar } from "../src/calendar-refresh.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const LIVE_MS = 60_000;           // ≥1 live match      -> ~1 min (feels live)
const UPCOMING_MS = 10 * 60_000;  // matches upcoming    -> 10 min
const IDLE_MS = 30 * 60_000;      // nothing on          -> 30 min
const ERROR_MS = 5 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canDeploy =
  process.env.REFRESH_DEPLOY !== "0" &&
  !!(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);

// Weekly self-refresh of the curated pro calendar (public/data/calendar.json) from
// Wikipedia. Runs on the first cycle after start, then ~weekly; guarded inside
// refreshCalendar so a bad parse never overwrites the last good file. Keeps the
// Upcoming timeline current without manual upkeep.
let lastCalRefresh = 0;
async function maybeRefreshCalendar(date) {
  if (Date.now() - lastCalRefresh < 7 * 24 * 3600 * 1000) return;
  lastCalRefresh = Date.now();
  try {
    const n = await refreshCalendar(root, { date });
    console.log(`  calendar refreshed: ${n} Premier Padel events`);
  } catch (e) {
    console.error("  calendar refresh skipped:", e.message);
  }
}

async function cycle() {
  const date = new Date().toISOString().slice(0, 10);
  await maybeRefreshCalendar(date);
  const { matches, sources } = await aggregate({ date });
  const counts = matches.reduce((a, m) => ((a[m.status] = (a[m.status] || 0) + 1), a), {});

  const outDir = join(root, "public", "data");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "matches.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), date, count: matches.length, matches }, null, 2)
  );

  // Rankings change ~weekly and RankedIn is heavier than the match feed, so refresh
  // them at most every 6h (or when missing/empty) instead of every cycle. Without
  // this the daemon left rankings.json empty and /api/health stuck on a warn.
  const rf = join(outDir, "rankings.json");
  let rankings = 0;
  let rankingsFresh = false;
  try {
    if (existsSync(rf)) {
      const rj = JSON.parse(readFileSync(rf, "utf8"));
      rankings = (rj.lists || []).length;
      rankingsFresh = rankings > 0 && (Date.now() - Date.parse(rj.generatedAt || 0)) < 6 * 3600 * 1000;
    }
  } catch {}
  if (!rankingsFresh) {
    try {
      const lists = await fetchRankings({ log: () => {} });
      if (lists.length) {
        writeFileSync(rf, JSON.stringify({ generatedAt: new Date().toISOString(), lists }, null, 2));
        rankings = lists.length;
      }
    } catch (e) { console.error("  rankings refresh failed:", e.message); }
  }

  // Tag each source with its last-success time (transient blip -> warn vs
  // persistent outage -> down at /api/health). Local snapshot persists between
  // cycles here, so no live fetch is needed. Must match fetch-live.js (the GH path)
  // or one producer clobbers lastOkAt on the shared endpoint. See health-history.js.
  const sourcesWithHistory = await attachSourceHistory(sources, { outDir });

  // health snapshot for /api/health — the loop, not just fetch-live.js, must write
  // this or generated_at goes stale and the dead-man's-switch reports "down" even
  // while the site is being refreshed.
  writeFileSync(
    join(outDir, "health.json"),
    JSON.stringify({
      generated_at: new Date().toISOString(),
      total: matches.length,
      sources: sourcesWithHistory,   // [{id, ok, count, error?, lastOkAt}] per adapter
      rankings,
      byStatus: counts,
    }, null, 2)
  );

  if (canDeploy) {
    stampAppVersion(root); // content-hash cache-bust: app.js?v=<hash> before every deploy
    try {
      execSync(
        "npx --yes wrangler@4 pages deploy public --project-name padel-livescore --branch main --commit-dirty=true",
        { cwd: root, stdio: "inherit" }
      );
    } catch (e) {
      console.error("  deploy failed:", e.message);
    }
  }

  const delay = counts.live ? LIVE_MS : counts.upcoming ? UPCOMING_MS : IDLE_MS;
  console.log(
    `[${new Date().toISOString()}] ${matches.length} matches ${JSON.stringify(counts)} ` +
      `→ next in ${Math.round(delay / 60000)}m${counts.live ? "  🔴 LIVE" : ""}`
  );
  return delay;
}

// Rewrite public/index.html's `app.js?v=…` to a short hash of public/app.js so the
// cache-bust token is DERIVED from content, not hand-bumped. A given ?v=<hash> URL
// therefore always maps to exactly that app.js — even a deploy of a mid-edit tree is
// self-consistent, so the CDN/browser can never pin a version string to stale JS
// (the bug that kept forcing manual version bumps). The GH Actions path does the
// equivalent with the commit SHA; this is its daemon counterpart. Left in place (not
// restored): the value is always valid for the current app.js, and both deploy paths
// re-stamp anyway, so a committed hash is harmless.
function stampAppVersion(root) {
  try {
    const idx = join(root, "public", "index.html");
    const hash = createHash("sha1").update(readFileSync(join(root, "public", "app.js"))).digest("hex").slice(0, 8);
    const html = readFileSync(idx, "utf8");
    const stamped = html.replace(/app\.js\?v=[\w.-]+/g, `app.js?v=${hash}`);
    if (stamped !== html) writeFileSync(idx, stamped);
  } catch (e) {
    console.error("  version stamp failed:", e.message);
  }
}

console.log(`refresh-loop starting — deploy ${canDeploy ? "ON" : "OFF (local only)"}`);
for (;;) {
  let delay = IDLE_MS;
  try {
    delay = await cycle();
  } catch (e) {
    console.error("cycle error:", e.message);
    delay = ERROR_MS;
  }
  await sleep(delay);
}
