// Merge padelnetwork bracket results into wpt.json's per-tournament `rounds`.
//
//   node scripts/padelnetwork-rounds-merge.mjs 2015            # dry run
//   node scripts/padelnetwork-rounds-merge.mjs 2015 --apply
//
// Before writing anything it runs an ACCURACY GATE: the two Semifinal winners of a draw must
// be the two finalists the archive already holds from Wikipedia/FIP. That is an independent
// check — the brackets and the finals come from different sources — so a low agreement rate
// means the draws were attributed to the wrong tournaments and the merge should not proceed.
//
// Finals are never written: they stay authoritative from Wikipedia/FIP, exactly as with the
// news-extraction pipeline.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WPT = join(ROOT, "public/data/archive/wpt.json");
const YEAR = +(process.argv.find((a) => /^\d{4}$/.test(a)) || 2015);
const APPLY = process.argv.includes("--apply");
const MIN_AGREE = 0.7; // below this, assume mis-attribution rather than bad archive data

const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, "");
const MONTHS = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const STOP = new Set(["open", "master", "masters", "final", "finals", "padel", "tour", "challenger",
  "internacional", "international", "estrella", "damm", "cerveza", "cervezas", "by", "de", "del", "la", "el"]);
const tokens = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)));
const overlap = (a, b) => {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
};
const nameKey = (arr) => (arr || []).map(slug).sort().join("+");
const parseSets = (score) => [...String(score).matchAll(/(\d{1,2})-(\d{1,2})/g)].map((m) => [m[1], m[2]]);
const RORDER = { Final: 7, Semifinal: 6, Quarterfinal: 5, "Round of 16": 4, "Round of 32": 3, "Round of 64": 2, Qualifying: 1 };

const wpt = JSON.parse(readFileSync(WPT, "utf8"));
const matches = JSON.parse(readFileSync(join(ROOT, `scratch/pn-rounds-${YEAR}.json`), "utf8"));
const yearTourns = wpt.tournaments.filter((t) => t.year === YEAR);

// --- match each padelnetwork draw-path to an archive tournament -------------
// The path carries month and city (/wpt/2015/marzo/barcelona/), which together disambiguate
// the repeat visits a season makes to the same city (Valencia in April AND November).
const paths = [...new Set(matches.map((m) => m.path))];
const pathTo = new Map();
const unmatched = [];
for (const p of paths) {
  const seg = p.split("/").filter(Boolean);          // wpt, year, month, city
  const month = MONTHS[seg[2]] || null, city = seg[3] || "";
  const label = matches.find((m) => m.path === p)?.name || "";
  let best = null, bestScore = 0;
  for (const t of yearTourns) {
    let s = 0;
    const tCity = slug((t.city || "").split("(")[0]), pCity = slug(city);
    // the archive stores some cities in English against padelnetwork's Spanish
    // ("Seville"/"sevilla"), so fall back to a shared prefix
    if (tCity && pCity) {
      if (tCity.includes(pCity) || pCity.includes(tCity)) s += 3;
      else if (tCity.slice(0, 5) === pCity.slice(0, 5)) s += 2.5;
    }
    s += 3 * overlap(label, t.name || "");
    // The month is the decisive signal: a season revisits cities, and a label can name a
    // city it isn't held in ("Estrella Damm Master Final Madrid" is December's Masters
    // Final, not September's Madrid Open), so a distant month has to actively disqualify.
    if (month && t.start) {
      const tm = +t.start.slice(5, 7);
      const d = Math.min(Math.abs(tm - month), 12 - Math.abs(tm - month));
      s += d === 0 ? 3 : d === 1 ? 1 : -3;
    }
    if (s > bestScore) { bestScore = s; best = t; }
  }
  if (best && bestScore >= 3) pathTo.set(p, best); else unmatched.push(`${p} (${label})`);
}
console.log(`${paths.length} draws mapped to ${new Set([...pathTo.values()]).size} archive tournaments; ${unmatched.length} unmatched`);
unmatched.forEach((u) => console.log(`  · ${u}`));

// --- accuracy gate: semifinal winners must be the archive's two finalists ----
let checked = 0, agree = 0;
const disagreements = [];
const sfBy = {};
for (const m of matches) if (m.round === "Semifinal") (sfBy[`${m.path}|${m.gender}`] ||= []).push(m.winners);
for (const [k, winners] of Object.entries(sfBy)) {
  if (winners.length !== 2) continue;
  const [p, gender] = k.split("|");
  const t = pathTo.get(p); if (!t) continue;
  const f = t.finals?.[gender]; if (!f?.winners) continue;
  checked++;
  const finalists = new Set([nameKey(f.winners), nameKey(f.runnersUp)]);
  const hit = winners.filter((w) => finalists.has(nameKey(w))).length;
  // names differ across sources (nicknames, second surnames), so also allow a surname-level match
  const surn = new Set([...(f.winners || []), ...(f.runnersUp || [])].flatMap((n) => slug(n).slice(-6)));
  const soft = winners.filter((w) => w.some((n) => surn.has(slug(n).slice(-6)))).length;
  if (hit === 2 || soft === 2) agree++;
  else disagreements.push(`${t.name} ${gender}: sf=${winners.map((w) => w.join("/")).join(" + ")} | final=${(f.winners || []).join("/")} vs ${(f.runnersUp || []).join("/")}`);
}
const rate = checked ? agree / checked : 0;
console.log(`\nACCURACY GATE — semifinal winners vs archive finalists: ${agree}/${checked} (${Math.round(rate * 100)}%)`);
disagreements.slice(0, 8).forEach((d) => console.log(`  ⚠ ${d}`));
if (disagreements.length > 8) console.log(`  … and ${disagreements.length - 8} more`);

// --- attach rounds ----------------------------------------------------------
let added = 0, dupes = 0;
const staged = new Map();
for (const m of matches) {
  if (m.round === "Final") continue;                 // finals stay from Wikipedia/FIP
  const t = pathTo.get(m.path); if (!t) continue;
  const entry = { gender: m.gender, round: m.round, winners: m.winners, losers: m.losers,
    score: m.score, sets: parseSets(m.score), confidence: "high", source: "padelnetwork" };
  const k = `${t.key}|${m.gender}|${m.round}|${nameKey(m.winners)}|${nameKey(m.losers)}`;
  if (staged.has(k)) continue;
  const existing = (t.rounds || []).some((r) => r.gender === m.gender && r.round === m.round
    && nameKey(r.winners) === nameKey(m.winners) && nameKey(r.losers) === nameKey(m.losers));
  if (existing) { dupes++; continue; }
  staged.set(k, { t, entry });
  added++;
}
console.log(`\n${added} new rounds to attach (${dupes} already present from the news extraction)`);

if (!APPLY) { console.log(`\n(dry run — nothing written. re-run with --apply)`); process.exit(0); }
if (rate < MIN_AGREE) {
  console.log(`\n❌ accuracy gate failed (${Math.round(rate * 100)}% < ${MIN_AGREE * 100}%) — refusing to write.`);
  process.exit(1);
}

const before = wpt.tournaments.length;
for (const { t, entry } of staged.values()) (t.rounds ||= []).push(entry);
for (const t of wpt.tournaments) if (t.rounds) t.rounds.sort((a, b) => (RORDER[b.round] || 0) - (RORDER[a.round] || 0));
if (wpt.tournaments.length !== before) { console.log("❌ tournament count changed — aborting"); process.exit(1); }
wpt.generatedAt = new Date().toISOString();
wpt.roundsNote = `Deeper rounds from padelnetwork brackets (2010-2022) and padel-magazine news (2013-2023); finals + rankings remain from Wikipedia/FIP.`;
wpt.roundsSeasons = [...new Set([...(wpt.roundsSeasons || []), YEAR])].sort();
writeFileSync(WPT, JSON.stringify(wpt, null, 2));
const total = wpt.tournaments.reduce((a, t) => a + (t.rounds?.length || 0), 0);
console.log(`\n✅ wrote wpt.json — +${added} rounds (${total} total across the archive)`);
