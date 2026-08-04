// WPT round-results — STEP 3: merge the extracted part files into wpt.json.
// Adds a `rounds` array (semis/quarters/etc., with scores) to each tournament,
// keeping the Wikipedia FINAL authoritative (extracted finals are only used as an
// accuracy cross-check, never overwritten).
//
//   node scripts/wpt-rounds-merge.mjs 2019
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YEAR = +(process.argv[2] || 2019);
const WPT = join(ROOT, "public/data/archive/wpt.json");
const SCRATCH = join(ROOT, "scratch");

const norm = (s) => (s || "").trim();
const nameKey = (arr) => (arr || []).map((n) => norm(n).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")).sort().join("+");
const parseSets = (score) => {
  const out = [];
  for (const part of norm(score).replace(/\s*(ab\.?|wo|w\/o|ret\.?)\s*$/i, "").split(/\s+/)) {
    const m = part.match(/(\d+)-(\d+)/); // keep the games digit; tie-break "(6)" is dropped from the cell
    if (m) out.push([m[1], m[2]]);
  }
  return out;
};
const RORDER = { "Final": 6, "Semifinal": 5, "Quarterfinal": 4, "Round of 16": 3, "Round of 32": 2, "Qualifying": 1 };

const wpt = JSON.parse(readFileSync(WPT, "utf8"));
const byKey = new Map(wpt.tournaments.map((t) => [t.key, t]));

// gather all parts for the year
const parts = readdirSync(SCRATCH).filter((f) => f.startsWith(`wpt-rounds-${YEAR}.part-`) && f.endsWith(".json"));
let raw = [];
for (const f of parts) {
  try { const a = JSON.parse(readFileSync(join(SCRATCH, f), "utf8")); if (Array.isArray(a)) raw.push(...a); }
  catch (e) { console.log(`  ! skipped ${f}: ${e.message}`); }
}
console.log(`loaded ${raw.length} extracted matches from ${parts.length} part file(s)`);

// validate + dedupe (keep highest confidence / most sets)
const CONF = { high: 3, medium: 2, low: 1 };
const seen = new Map();
let dropped = 0;
for (const r of raw) {
  const t = byKey.get(r.key);
  if (!t) { dropped++; continue; }
  if (!Array.isArray(r.winners) || r.winners.length !== 2 || !Array.isArray(r.losers) || r.losers.length !== 2) { dropped++; continue; }
  const sets = parseSets(r.score);
  if (!sets.length) { dropped++; continue; }
  const k = `${r.key}|${r.gender}|${r.round}|${nameKey(r.winners)}|${nameKey(r.losers)}`;
  const score = (CONF[r.confidence] || 1) * 10 + sets.length;
  const prev = seen.get(k);
  if (!prev || score > prev._score) seen.set(k, { ...r, sets, _score: score });
}
const matches = [...seen.values()];
console.log(`${matches.length} unique matches after dedupe (${dropped} dropped: unknown key / bad pair / no score)`);

// cross-check extracted FINALS against the authoritative Wikipedia finals
let finalsChecked = 0, finalsAgree = 0;
const mism = [];
for (const m of matches.filter((x) => x.round === "Final")) {
  const t = byKey.get(m.key); const f = t?.finals?.[m.gender];
  if (!f) continue;
  finalsChecked++;
  if (nameKey(f.winners) === nameKey(m.winners)) finalsAgree++;
  else mism.push(`${t.name} ${m.gender}: wiki=${(f.winners || []).join("/")} vs news=${m.winners.join("/")}`);
}
console.log(`\nFINALS cross-check: ${finalsAgree}/${finalsChecked} extracted finals match Wikipedia's winner`);
mism.slice(0, 10).forEach((x) => console.log(`  ⚠ ${x}`));

// attach NON-final rounds to each tournament (finals stay from Wikipedia)
for (const t of wpt.tournaments) if (t.year === YEAR && t.rounds) delete t.rounds; // clean prior run of THIS year only
let attached = 0;
for (const m of matches) {
  if (m.round === "Final") continue; // final is authoritative from finals{}
  const t = byKey.get(m.key);
  (t.rounds ||= []).push({ gender: m.gender, round: m.round, winners: m.winners, losers: m.losers, score: m.score, sets: m.sets, confidence: m.confidence });
  attached++;
}
for (const t of wpt.tournaments) if (t.rounds) t.rounds.sort((a, b) => (RORDER[b.round] || 0) - (RORDER[a.round] || 0));

wpt.generatedAt = new Date().toISOString();
wpt.roundsNote = `Deeper rounds (semis/quarters/…) extracted from padel-magazine news; finals + rankings remain from Wikipedia.`;
// Mark this season processed so a self-healing/recurring run skips it next time — even
// if it yielded 0 rounds (a genuinely thin season shouldn't be retried forever).
wpt.roundsSeasons = [...new Set([...(wpt.roundsSeasons || []), YEAR])].sort();
writeFileSync(WPT, JSON.stringify(wpt, null, 2));

const withRounds = wpt.tournaments.filter((t) => t.year === YEAR && t.rounds?.length).length;
const yTot = wpt.tournaments.filter((t) => t.year === YEAR).length;
console.log(`\n✅ attached ${attached} non-final rounds to ${withRounds}/${yTot} of the ${YEAR} tournaments -> wpt.json`);
