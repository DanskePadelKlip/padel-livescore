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
import { aggregate } from "../src/aggregate.js";
import { fetchRankings } from "../src/rankings.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const LIVE_MS = 60_000;           // ≥1 live match      -> ~1 min (feels live)
const UPCOMING_MS = 10 * 60_000;  // matches upcoming    -> 10 min
const IDLE_MS = 30 * 60_000;      // nothing on          -> 30 min
const ERROR_MS = 5 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canDeploy =
  process.env.REFRESH_DEPLOY !== "0" &&
  !!(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);

async function cycle() {
  const date = new Date().toISOString().slice(0, 10);
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

  // health snapshot for /api/health — the loop, not just fetch-live.js, must write
  // this or generated_at goes stale and the dead-man's-switch reports "down" even
  // while the site is being refreshed.
  writeFileSync(
    join(outDir, "health.json"),
    JSON.stringify({
      generated_at: new Date().toISOString(),
      total: matches.length,
      sources,                       // [{id, ok, count, error?}] per adapter
      rankings,
      byStatus: counts,
    }, null, 2)
  );

  if (canDeploy) {
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
