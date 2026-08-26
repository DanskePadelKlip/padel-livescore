// Capture the Sporteaser live feed for one or more tournaments.
//
// TWO LAYERS, on purpose:
//
// 1. SAFETY NET - poll the whole-day feed and keep every CHANGED response
//    (gzipped, named by the UTC instant observed). One 520 KB response covers
//    every court, so this is cheaper than one per-match poller and it means no
//    match is ever unrecoverable. Belgrade lost two matches to "nobody was
//    polling"; reconstructing one of them off a YouTube restream took audio
//    cross-correlation and per-cell board classification.
//
// 2. PRIORITY POLLERS - for matches we actually intend to burn a scoreboard
//    into, poll the PER-MATCH endpoint every 3s and write the exact TSV that
//    scoreboard-tools/poll_live.py produces, so timeline_from_live.py consumes
//    it unchanged. Selected by: any Nordic player, or any pair seeded 1-4.
//
// The day feed carries no seeding, so seeds come from PadelTicker's own feed
// (team names there end in "(1)".."(4)") and are matched pairwise. Nordic is
// decided straight off the Sporteaser lineups, which do carry country.
//
//   node scripts/capture-sporteaser.mjs 397 [412 ...]
//   node scripts/capture-sporteaser.mjs --dry-run 397     # print selection, poll nothing

import { writeFileSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const OUT = process.env.SPORTEASER_OUT || "C:\\Users\\Dansk\\sporteaser-capture";
const FEED = "https://padelticker.com/data/matches.json";
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const FROM_FILE = (argv.find((a) => a.startsWith("--from-file=")) || "").slice(12) || null;
const TIDS = argv.filter((a) => !a.startsWith("--"));
if (!TIDS.length) TIDS.push("397");

const DAY_LIVE_MS = 25_000, DAY_IDLE_MS = 5 * 60_000, DAY_OFF_MS = 30 * 60_000;
const MATCH_MS = 3_000;              // matches poll_live.py's default
const SEED_MAX = 4;                  // "top 4 pairs" = seeds 1-4 in the draw
const SEED_REFRESH_MS = 6 * 3600_000;
const NORDIC = new Set(["denmark", "sweden", "norway", "finland", "iceland", "faroe islands"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastHash = new Map();
const active = new Map();            // matchId -> true while a priority poller runs
let seedEntries = [], seedAt = 0;    // [{name, tokens:Set, pairs:[[a,b]]}] per tournament

const stampFile = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
// poll_live.py writes python's isoformat: "...+00:00", not "...Z". Keep it identical.
const stampRow = () => new Date().toISOString().replace("Z", "+00:00");

const lineup = (m) => [...(m.homeTeamLineup || []), ...(m.awayTeamLineup || [])]
  .map((e) => e && e.player).filter(Boolean);
const isNordic = (m) => lineup(m).some((p) => p.country && NORDIC.has(String(p.country.name || "").toLowerCase()));
// Tournament names differ between the two feeds ("FIP GOLD BELGRADE" vs
// "FIP Gold Belgrade 2026"), so compare TOKEN SETS with the year dropped. Without
// this, a seeded surname from any other event in PadelTicker's feed could match a
// player here by coincidence.
const tokens = (s) => new Set(String(s || "").toUpperCase().split(/[^A-Z0-9]+/)
  .filter((t) => t.length > 2 && !/^(19|20)\d\d$/.test(t)));
// Two rules here, and both were needed to get this right on real data.
//
// Match on the PAIR, not on either surname: "Ruiz" and "Garcia" are both seeded
// in this draw, and either alone drags in every Garcia in the tournament. Both
// members of one seeded pair must land on the SAME side.
//
// Compare on TOKENS of the whole name, not on lastName equality, because:
//   - the feeds abbreviate compound surnames differently ("Nieto" vs "Nieto
//     Ruiz", "Ruiz" vs "Ruiz Granados"), so equality drops real seeds;
//   - Sporteaser sometimes stores the name surname-first, so A. Radu arrives as
//     lastName "Alice", firstName "Radu".
// Taking first+last tokens together and asking whether PadelTicker's surname
// tokens are a subset survives both. Same approach as the sporteaser adapter.
const nameTokens = (p) => new Set(`${p.firstName || ""} ${p.lastName || ""}`
  .toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter(Boolean));
const sideBlobs = (m, side) => (m[side] || []).map((e) => e && e.player)
  .filter(Boolean).map(nameTokens);
const hits = (surname, blob) => {
  const t = surname.split(/[^a-zà-ÿ0-9]+/).filter(Boolean);
  return t.length > 0 && t.every((x) => blob.has(x));
};
function isSeeded(m) {
  const mt = tokens(m.tournament && m.tournament.name);
  const sides = [sideBlobs(m, "homeTeamLineup"), sideBlobs(m, "awayTeamLineup")];
  return seedEntries.some((e) => {
    if (![...e.tokens].every((t) => mt.has(t))) return false;
    return e.pairs.some(([a, b]) => sides.some((s) => s.length >= 2 &&
      ((hits(a, s[0]) && hits(b, s[1])) || (hits(a, s[1]) && hits(b, s[0])))));
  });
}
function why(m) {
  const r = [];
  if (isNordic(m)) r.push("nordic");
  if (isSeeded(m)) r.push("seed<=" + SEED_MAX);
  return r;
}

// Seeds live in PadelTicker's team names ("J. Nieto / M. Yanguas (1)"). Collect each
// seeded PAIR as a surname couple, keyed by tournament, so isSeeded() can require both
// members on one side rather than trusting a single (often common) surname.
async function refreshSeeds() {
  const res = await fetch(FEED, { cache: "no-store" });
  if (!res.ok) throw new Error("feed HTTP " + res.status);
  const d = await res.json();
  const byTournament = new Map();                             // name -> Map(pairKey -> surnames[])
  for (const m of d.matches || []) {
    const tname = (m.tournament && m.tournament.name) || "";
    if (!tname) continue;
    for (const t of m.teams || []) {
      const hit = /\((\d)\)\s*$/.exec(t.name || "");          // "(1)" yes, "(WC)"/"(Q)" no
      if (!hit || +hit[1] > SEED_MAX) continue;
      const pair = (t.players || []).map((p) => {
        const parts = String(p.name || "").trim().split(/\s+/);
        const last = parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
        return last.replace(/\(.*$/, "").trim().toLowerCase();
      }).filter(Boolean);
      if (pair.length < 2) continue;
      if (!byTournament.has(tname)) byTournament.set(tname, new Map());
      byTournament.get(tname).set([...pair].sort().join("|"), pair);
    }
  }
  seedEntries = [...byTournament].map(([name, pairs]) =>
    ({ name, tokens: tokens(name), pairs: [...pairs.values()] }));
  seedAt = Date.now();
  return seedEntries;
}

const ORD = ["First", "Second", "Third", "Fourth", "Fifth"];
function boardState(d) {
  const res = d.results || {};
  const sets = [];
  for (const o of ORD) {
    const h = res[`matchHomeTeam${o}PeriodScore`], a = res[`matchAwayTeam${o}PeriodScore`];
    if (h == null && a == null) continue;
    const th = res[`matchHomeTeam${o}PeriodTBScore`], ta = res[`matchAwayTeam${o}PeriodTBScore`];
    sets.push(`${h}-${a}` + (th != null ? `(${th}-${ta})` : ""));
  }
  return [
    `${res.matchHomeTeamScore}:${res.matchAwayTeamScore}`,
    sets.join(","),
    `${res.matchHomeTeamCurrentStatus}:${res.matchAwayTeamCurrentStatus}`,
    String(res.teamInPossession),
    String(d.matchStatus),
  ].join("\t");
}

async function pollMatch(tid, m, reasons) {
  const id = m.id;
  if (active.has(id)) return;
  active.set(id, true);
  const dir = join(OUT, String(tid));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `live_${id}.tsv`);
  const label = [m.fieldName, m.round, reasons.join("+")].filter(Boolean).join(" | ");
  appendFileSync(file, `# ${stampRow()} start ${label}\n`, "utf8");
  console.log(`[${new Date().toISOString()}] PRIORITY ${id}: ${label}`);
  let prev = null, errs = 0;
  try {
    for (;;) {
      try {
        const r = await fetch(`https://v0.sporteaser.app/api/public/live/match/detail/1/${id}`);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();
        const s = boardState(d);
        if (s !== prev) { appendFileSync(file, stampRow() + "\t" + s + "\n", "utf8"); prev = s; }
        errs = 0;
        if (String(d.matchStatus) === "4") {
          appendFileSync(file, "# matchStatus=4 (finished)\n", "utf8");
          console.log(`[${new Date().toISOString()}] PRIORITY ${id}: finished`);
          break;
        }
      } catch (e) {
        // The per-match endpoint 500s intermittently (seen in live_48305.tsv).
        // Log and keep going; only give up after a long run of failures.
        appendFileSync(file, `# err ${e.message}\n`, "utf8");
        if (++errs >= 100) { appendFileSync(file, "# giving up\n", "utf8"); break; }
      }
      await sleep(MATCH_MS);
    }
  } finally { active.delete(id); }
}

async function pollDay(tid) {
  const day = new Date().getUTCDate();
  let body;
  if (FROM_FILE) {
    // Replay a stored snapshot instead of fetching. Lets the selection be tested
    // against a day that actually had live matches, rather than an empty evening.
    body = gunzipSync(readFileSync(FROM_FILE)).toString("utf8");
  } else {
    const r = await fetch(`https://v0.sporteaser.app/api/public/tournament/${tid}/matches/day/${day}/sort/fieldname/0`,
      { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    body = await r.text();
  }
  if (body.length < 100) throw new Error("suspiciously short body");

  const hash = createHash("sha1").update(body).digest("hex");
  if (lastHash.get(tid) !== hash && !DRY) {
    mkdirSync(join(OUT, String(tid)), { recursive: true });
    writeFileSync(join(OUT, String(tid), `${stampFile()}.json.gz`), gzipSync(body));
    lastHash.set(tid, hash);
  }

  let live = 0, onDay = true;
  const watched = [];
  try {
    const j = JSON.parse(body);
    const arr = Array.isArray(j) ? j : (j.matches || j.data || []);
    if (Array.isArray(j.days) && j.days.length) onDay = j.days.includes(day);
    for (const m of arr) {
      const isLive = m.matchStatus === 2;
      if (isLive) live++;
      const reasons = why(m);
      if (!reasons.length) continue;
      // A dry run classifies EVERY match so the selection can be inspected on a
      // day that is already over; a real run only polls what is on court now.
      if (DRY) { watched.push({ m, reasons, isLive }); continue; }
      if (!isLive) continue;
      watched.push({ m, reasons, isLive });
      pollMatch(tid, m, reasons);                // fire and forget; it self-retires
    }
  } catch { /* unparseable -> bytes still stored */ }
  return { live, onDay, watched };
}

console.log(`capture-sporteaser starting -> ${OUT}  tournaments: ${TIDS.join(", ")}${DRY ? "  [DRY RUN]" : ""}`);
for (;;) {
  if (Date.now() - seedAt > SEED_REFRESH_MS) {
    try {
      await refreshSeeds();
      const tot = seedEntries.reduce((n, e) => n + e.pairs.length, 0);
      console.log(`seeds 1-${SEED_MAX}: ${tot} pairs across ${seedEntries.length} tournaments`);
    } catch (e) { console.error("seed refresh failed:", e.message); }
  }
  let live = 0, onDay = false;
  for (const tid of TIDS) {
    try {
      const r = await pollDay(tid);
      live += r.live; onDay = onDay || r.onDay;
      if (DRY) {
        const liveHits = r.watched.filter((w) => w.isLive).length;
        console.log(`${tid}: ${r.live} live now | ${r.watched.length} matches selected (${liveHits} of them live)`);
        for (const w of r.watched) {
          console.log(`   ${w.isLive ? "LIVE " : "     "}${w.m.id} ${String(w.m.fieldName || "").padEnd(8)}` +
            `${lineup(w.m).map((p) => p.lastName).join(" / ").padEnd(52)} [${w.reasons.join("+")}]`);
        }
      }
    } catch (e) { console.error(`[${new Date().toISOString()}] ${tid}: ${e.message}`); }
  }
  if (DRY) break;
  await sleep(!onDay ? DAY_OFF_MS : live ? DAY_LIVE_MS : DAY_IDLE_MS);
}
