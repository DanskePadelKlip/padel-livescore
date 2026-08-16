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
// Sources spell the same player differently — nicknames (Sanyo/Carlos Daniel), the Spanish
// second surname one side keeps (Matías Díaz / Matías Díaz Sangiorgio), accents. Score names
// on shared distinctive tokens, as import-fip-finals-merge.mjs does, so the gate measures
// mis-attribution rather than spelling.
const nameToks = (s) => slug(s).length ? norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4) : [];
function playerScore(a, b) {
  const A = nameToks(a), B = nameToks(b);
  if (!A.length || !B.length) return 0;
  let sc = 2 * A.filter((w) => B.includes(w)).length;
  if (A.some((x) => B.some((y) => x !== y && (x.startsWith(y) || y.startsWith(x))))) sc += 1;
  return sc;
}
function samePair(p, q) {
  if (!p?.length || !q?.length || p.length !== q.length) return false;
  const straight = Math.min(playerScore(p[0], q[0]), playerScore(p[1], q[1]));
  const swapped = Math.min(playerScore(p[0], q[1]), playerScore(p[1], q[0]));
  return Math.max(straight, swapped) >= 2;
}
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

// Score every (draw, tournament) pair, then assign greedily best-first, one-to-one. A plain
// per-draw argmax lets two draws claim the same tournament — which is how a mis-attribution
// gets in — and 2013 is the case that needs it: four of its tournaments carry a placeholder
// 2013-01-01 start, so the month can't separate them and only exclusivity can.
const scored = [];
for (const p of paths) {
  // /wpt/{year}/{month}/{city}/ but /ppt/{country}/{year}/{month}/{city}/ — the PPT era
  // carries an extra country segment, so index from the end rather than the front.
  const seg = p.split("/").filter(Boolean);
  const month = MONTHS[seg[seg.length - 2]] || null, city = seg[seg.length - 1] || "";
  const label = matches.find((m) => m.path === p)?.name || "";
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
    // The legacy tree gives every event the same useless <title> (", PPT 2007 …, España") and
    // names its directory for the REGION where the archive stores the host city — euskadi vs
    // Bilbao, balears vs Palma de Mallorca. The region does appear in the tournament's name,
    // so match the slug against that too.
    const slugWord = pCity.replace(/^ppt/, "").replace(/\d+$/, "");
    if (slugWord.length > 3 && slug(t.name || "").includes(slugWord)) s += 3;
    // The month is the decisive signal where it exists: a season revisits cities, and a label
    // can name a city it isn't held in ("Estrella Damm Master Final Madrid" is December's
    // Masters Final, not September's Madrid Open), so a distant month must disqualify. A
    // placeholder 01-01 start carries no information, so it neither helps nor penalises.
    const placeholder = t.start?.endsWith("-01-01");
    if (month && t.start && !placeholder) {
      const tm = +t.start.slice(5, 7);
      const d = Math.min(Math.abs(tm - month), 12 - Math.abs(tm - month));
      s += d === 0 ? 3 : d === 1 ? 1 : -3;
    }
    if (s >= 3) scored.push({ p, t, s });
  }
}
scored.sort((a, b) => b.s - a.s);
const takenT = new Set();
for (const { p, t, s } of scored) {
  if (pathTo.has(p) || takenT.has(t.key)) continue;
  pathTo.set(p, t); takenT.add(t.key);
}
const unmatched = paths.filter((p) => !pathTo.has(p))
  .map((p) => `${p} (${matches.find((m) => m.path === p)?.name || ""})`);
console.log(`${paths.length} draws mapped to ${new Set([...pathTo.values()]).size} archive tournaments; ${unmatched.length} unmatched`);
unmatched.forEach((u) => console.log(`  · ${u}`));

// --- accuracy gate: semifinal winners must be the archive's two finalists ----
let checked = 0, agree = 0;
const disagreements = [];
const verdict = new Map();   // "path|gender" -> "pass" | "fail"
const sfBy = {};
for (const m of matches) if (m.round === "Semifinal") (sfBy[`${m.path}|${m.gender}`] ||= []).push(m.winners);
for (const [k, winners] of Object.entries(sfBy)) {
  if (winners.length !== 2) continue;
  const [p, gender] = k.split("|");
  const t = pathTo.get(p); if (!t) continue;
  const f = t.finals?.[gender]; if (!f?.winners) continue;
  checked++;
  const finalists = [f.winners, f.runnersUp].filter((x) => x?.length === 2);
  const hit = winners.filter((w) => finalists.some((fin) => samePair(fin, w))).length;
  verdict.set(k, hit === 2 ? "pass" : "fail");
  if (hit === 2) agree++;
  else disagreements.push(`${t.name} ${gender}: sf=${winners.map((w) => w.join("/")).join(" + ")} | final=${(f.winners || []).join("/")} vs ${(f.runnersUp || []).join("/")}`);
}
const rate = checked ? agree / checked : 0;
console.log(`\nACCURACY GATE — semifinal winners vs archive finalists: ${agree}/${checked} (${Math.round(rate * 100)}%)`);
disagreements.slice(0, 8).forEach((d) => console.log(`  ⚠ ${d}`));
if (disagreements.length > 8) console.log(`  … and ${disagreements.length - 8} more`);

// --- attach rounds ----------------------------------------------------------
let added = 0, dupes = 0;
const staged = new Map();
let rejected = 0;
for (const m of matches) {
  if (m.round === "Final") continue;                 // finals stay from Wikipedia/FIP
  const t = pathTo.get(m.path); if (!t) continue;
  // Drop the whole draw when its semifinal winners are not the finalists the archive holds.
  // padelnetwork assembles pair cells from shared snippet files (Dreamweaver .lbi library
  // items keyed by pair), so when a partnership changes the snippet is updated and older
  // seasons inherit the NEW partner: every 2020 draw involving Gemma Triay renders her with
  // Alejandra Salazar, her 2021 partner, in place of Lucía Sainz. Those matches are wrong at
  // the source, so a season-wide pass/fail would either lose good draws or import bad ones.
  if (verdict.get(`${m.path}|${m.gender}`) === "fail") { rejected++; continue; }
  // A player cannot lose to themselves. The same snippet problem also corrupts the LOSING
  // pair of otherwise-sound draws — 2018/2019 semifinals render Gemma Triay's opponents as
  // "Triay/Salazar", her 2021 partnership — and the winners-only gate cannot see that.
  const wset = new Set(m.winners.map((n) => slug(n)));
  if (m.losers.some((l) => wset.has(slug(l)))) { rejected++; continue; }
  const entry = { gender: m.gender, round: m.round, winners: m.winners, losers: m.losers,
    score: m.score, sets: parseSets(m.score), confidence: "high", source: "padelnetwork" };
  const k = `${t.key}|${m.gender}|${m.round}|${nameKey(m.winners)}|${nameKey(m.losers)}`;
  if (staged.has(k)) continue;
  // Compare only against rounds this import won't replace, or a re-run would see its own
  // previous output as pre-existing and report nothing new.
  const existing = (t.rounds || []).some((r) => r.source !== "padelnetwork" && r.gender === m.gender
    && r.round === m.round && nameKey(r.winners) === nameKey(m.winners) && nameKey(r.losers) === nameKey(m.losers));
  if (existing) { dupes++; continue; }
  staged.set(k, { t, entry });
  added++;
}
console.log(`\n${added} new rounds to attach (${dupes} already present from the news extraction; ${rejected} dropped from draws that failed the gate)`);

if (!APPLY) { console.log(`\n(dry run — nothing written. re-run with --apply)`); process.exit(0); }
if (rate < MIN_AGREE) {
  console.log(`\n❌ accuracy gate failed (${Math.round(rate * 100)}% < ${MIN_AGREE * 100}%) — refusing to write.`);
  process.exit(1);
}

const before = wpt.tournaments.length;
// Idempotent: drop this year's previously-imported padelnetwork rounds before re-adding, so
// re-running after a parser fix replaces them instead of layering a second copy alongside.
// News-extracted rounds carry no `source` and are left untouched.
let replaced = 0;
for (const t of wpt.tournaments) {
  if (t.year !== YEAR || !t.rounds) continue;
  const kept = t.rounds.filter((r) => r.source !== "padelnetwork");
  replaced += t.rounds.length - kept.length;
  t.rounds = kept;
}
if (replaced) console.log(`(replacing ${replaced} rounds from a previous padelnetwork import)`);
for (const { t, entry } of staged.values()) (t.rounds ||= []).push(entry);
for (const t of wpt.tournaments) if (t.rounds) t.rounds.sort((a, b) => (RORDER[b.round] || 0) - (RORDER[a.round] || 0));
if (wpt.tournaments.length !== before) { console.log("❌ tournament count changed — aborting"); process.exit(1); }
wpt.generatedAt = new Date().toISOString();
wpt.roundsNote = `Deeper rounds from padelnetwork brackets (2010-2022) and padel-magazine news (2013-2023); finals + rankings remain from Wikipedia/FIP.`;
wpt.roundsSeasons = [...new Set([...(wpt.roundsSeasons || []), YEAR])].sort();
writeFileSync(WPT, JSON.stringify(wpt, null, 2));
const total = wpt.tournaments.reduce((a, t) => a + (t.rounds?.length || 0), 0);
console.log(`\n✅ wrote wpt.json — +${added} rounds (${total} total across the archive)`);
