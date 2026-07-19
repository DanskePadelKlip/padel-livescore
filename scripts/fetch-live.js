// CLI: run the aggregate pipeline and write public/data/matches.json.
// This stands in for the future scheduled edge worker.
//
//   node scripts/fetch-live.js            # today
//   node scripts/fetch-live.js 2026-07-12 # a specific day

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate } from "../src/aggregate.js";
import { fetchRankings } from "../src/rankings.js";
import { attachSourceHistory } from "../src/health-history.js";
import { newlyLive, newlySoon, sendAlerts, sendSoonAlerts } from "../src/alerts.js";
import { sendLivePush, sendStartingSoonPush } from "../src/push-send.js";
import { isoWeekKey, applyMovement } from "../src/rank-movement.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const date = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Date().toISOString().slice(0, 10);

console.log(`\n⚡ Fetching padel matches for ${date}\n`);
const { matches, sources } = await aggregate({ date, log: (m) => console.log(m) });

const tally = (key) =>
  matches.reduce((acc, m) => ((acc[m[key]] = (acc[m[key]] || 0) + 1), acc), {});

console.log(`\n📊 ${matches.length} matches total`);
console.log("   by status:", tally("status"));
console.log("   by federation:", tally("federation"));

const outDir = join(root, "public", "data");
mkdirSync(outDir, { recursive: true });

// Alerts: diff against the currently-published data (previous run) BEFORE we
// overwrite it. The "newly live" set feeds BOTH the webhook feed and Web Push.
if (process.env.ALERT_WEBHOOK_URL || process.env.VAPID_PRIVATE_KEY) {
  let prev = null;
  try {
    prev = await (await fetch("https://padelticker.com/data/matches.json?_=" + Date.now())).json();
  } catch (e) {
    console.log("\n🔔 prev-data fetch skipped:", e.message);
  }
  const prevMatches = prev?.matches || [];
  const nextAt = Date.now();
  const prevAt = Date.parse(prev?.generatedAt) || nextAt - 15 * 60_000;

  const fresh = newlyLive(prevMatches, matches);
  // "starting soon": FIP matches est. to start within 20 min (newly entered)
  const soon = newlySoon(prevMatches, prevAt, matches, nextAt, 20 * 60_000);
  console.log(`\n🔔 ${fresh.length} newly live · ${soon.length} starting soon`);

  const webhook = process.env.ALERT_WEBHOOK_URL;
  if (webhook) {
    if (fresh.length) console.log(`   webhook live: ${await sendAlerts(fresh, webhook)} sent`);
    if (soon.length) console.log(`   webhook soon: ${await sendSoonAlerts(soon, webhook)} sent`);
  }
  if (process.env.VAPID_PRIVATE_KEY) {
    await sendLivePush(fresh, { log: console.log });
    await sendStartingSoonPush(soon, { log: console.log });
  }
}

const payload = { generatedAt: new Date().toISOString(), date, count: matches.length, matches };
writeFileSync(join(outDir, "matches.json"), JSON.stringify(payload, null, 2));
console.log(`\n✅ Wrote public/data/matches.json`);

// national rankings (RankedIn) — regenerated each run, deployed with the site
console.log(`\n🏆 Fetching national rankings`);
const lists = await fetchRankings({ log: (m) => console.log(m) });
if (lists.length) {
  // week-over-week movement: diff against a weekly baseline persisted on Pages
  // (RankedIn only serves the current week, so we build history going forward).
  try {
    const weekKey = isoWeekKey();
    const grab = async (u) => {
      try { const r = await fetch(u + "?_=" + Date.now()); return r.ok ? await r.json() : null; } catch { return null; }
    };
    const [base, prev] = await Promise.all([
      grab("https://padelticker.com/data/rankings-base.json"),
      grab("https://padelticker.com/data/rankings.json"),
    ]);
    const baseToWrite = applyMovement(lists, base, prev?.lists || [], weekKey);
    writeFileSync(join(outDir, "rankings-base.json"), JSON.stringify(baseToWrite));
    const moving = lists.filter((l) => l.movement).length;
    console.log(`   movement baseline ${baseToWrite.weekOf} — ${moving}/${lists.length} lists tracked`);
  } catch (e) {
    console.log("   movement step skipped:", e.message);
  }
  writeFileSync(join(outDir, "rankings.json"), JSON.stringify({ generatedAt: new Date().toISOString(), lists }, null, 2));
  console.log(`✅ Wrote public/data/rankings.json (${lists.length} lists)\n`);
}

// health snapshot for /api/health (monitoring) — raw facts; the endpoint derives
// the verdict, incl. a freshness/dead-man's-switch check off generated_at. Tag each
// source with lastOkAt so a persistent outage escalates to "down" (must match
// refresh-loop.js). On CI the working copy is a fresh checkout with no local
// snapshot, so seed the history from the live site. See src/health-history.js.
const sourcesWithHistory = await attachSourceHistory(sources, {
  outDir,
  liveUrl: "https://padelticker.com/data/health.json",
});
writeFileSync(join(outDir, "health.json"), JSON.stringify({
  generated_at: new Date().toISOString(),
  total: matches.length,
  sources: sourcesWithHistory,   // [{id, ok, count, error?, lastOkAt}] per adapter
  rankings: (lists || []).length,
  byStatus: tally("status"),
}, null, 2));
console.log("✅ Wrote public/data/health.json");
