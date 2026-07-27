// Liveness probe for the "blocked-until-live" pro tour we still care about:
// the Pro Padel League. It publishes per-match scores only DURING a live event,
// so its adapter can't be built or verified while idle (verified 2026-07-13):
//   - Pro Padel League — data is in a PUBLIC, no-auth Firestore (clean JSON!),
//                  but the match/live collections are empty between events;
//                  only standings/teams/players persist.
// When it goes live, that's the ~30-min window to capture the feed and finish
// the adapter. Run this on a schedule; it exits 10 if something is live.
//
// A1 Padel was dropped 2026-07-20: the circuit cancelled its 2025 calendar and
// has shown no sign of life since (promised-but-undelivered 2026 relaunch). Its
// scoreboard was idle on every run we ever made. Not worth probing or building
// for until there's real evidence the tour is running events again.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const PPL_FS = "https://firestore.googleapis.com/v1/projects/pro-padel-league/databases/(default)/documents";

async function checkPPL() {
  const cols = ["matches", "liveMatches", "results"];
  try {
    const hits = [];
    let total = 0;
    for (const c of cols) {
      const d = await (await fetch(`${PPL_FS}/${c}?pageSize=5`, { headers: { "User-Agent": UA } })).json();
      const n = (d.documents || []).length;
      total += n;
      if (n) hits.push(`${c}:${n}`);
    }
    return {
      source: "Pro Padel League",
      live: total > 0,
      detail:
        total > 0
          ? `LIVE — Firestore now has ${hits.join(", ")}. Inspect a doc's fields and build a (trivial) Firestore adapter.`
          : "idle (matches/liveMatches/results collections empty)",
    };
  } catch (e) {
    return { source: "Pro Padel League", live: null, detail: "check failed: " + e.message };
  }
}

const results = await Promise.all([checkPPL()]);
console.log(`\n🎾 Live-source check — ${new Date().toISOString()}\n`);
let anyLive = false;
for (const r of results) {
  const icon = r.live === true ? "🔴 LIVE " : r.live === false ? "⚪ idle " : "⚠️  ?   ";
  console.log(`  ${icon} ${r.source} — ${r.detail}`);
  if (r.live) anyLive = true;
}
console.log(anyLive ? "\n>>> A source is LIVE — capture its feed and finish the adapter.\n" : "\nNothing live right now — check again later.\n");
process.exit(anyLive ? 10 : 0);
