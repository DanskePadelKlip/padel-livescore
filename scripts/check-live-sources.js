// Liveness probe for the two "blocked-until-live" pro tours: A1 Padel and the
// Pro Padel League. Both publish per-match scores only DURING a live event, so
// their adapters can't be built or verified while idle (verified 2026-07-13):
//   - A1 Padel   — a1padelglobal.com scoreboard shows a "scoreProxima" (coming
//                  soon) placeholder when nothing is live; the live feed only
//                  activates during a match.
//   - Pro Padel League — data is in a PUBLIC, no-auth Firestore (clean JSON!),
//                  but the match/live collections are empty between events;
//                  only standings/teams/players persist.
// When either goes live, that's the ~30-min window to capture the feed and
// finish the adapter. Run this on a schedule; it exits 10 if something is live.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const A1_SCOREBOARD = "https://www.a1padelglobal.com/scoreboard.aspx";
const PPL_FS = "https://firestore.googleapis.com/v1/projects/pro-padel-league/databases/(default)/documents";

async function checkA1() {
  try {
    const html = await (await fetch(A1_SCOREBOARD, { headers: { "User-Agent": UA } })).text();
    const idle = /scoreProxima/i.test(html); // "coming soon" placeholder = no live match
    return {
      source: "A1 Padel",
      live: !idle,
      detail: idle
        ? "idle (scoreProxima placeholder present)"
        : "placeholder gone — likely LIVE. Open scoreboard.aspx in the browser, capture the live feed (websocket/SignalR), then build a browser adapter.",
    };
  } catch (e) {
    return { source: "A1 Padel", live: null, detail: "check failed: " + e.message };
  }
}

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

const results = await Promise.all([checkA1(), checkPPL()]);
console.log(`\n🎾 Live-source check — ${new Date().toISOString()}\n`);
let anyLive = false;
for (const r of results) {
  const icon = r.live === true ? "🔴 LIVE " : r.live === false ? "⚪ idle " : "⚠️  ?   ";
  console.log(`  ${icon} ${r.source} — ${r.detail}`);
  if (r.live) anyLive = true;
}
console.log(anyLive ? "\n>>> A source is LIVE — capture its feed and finish the adapter.\n" : "\nNothing live right now — check again later.\n");
process.exit(anyLive ? 10 : 0);
