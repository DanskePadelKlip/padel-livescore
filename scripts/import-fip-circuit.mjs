// Import historic pro-tour FINALS from FIP's own structured API into wpt.json.
//
//   https://www.padelfip.com/wp-json/fip/v1/circuit-stats?year=YYYY&limit=500
//
// Each row is one FINAL (one gender) of one tournament, with the circuit tagged
// (PPT / WPT / PREMIER PADEL / CUPRA FIP TOUR), clean player names + FIP player ids,
// scores, city, country and date. Far cleaner than the Wikipedia scrape, and it
// covers the PRE-WPT era (Padel Pro Tour, 2006-2012).
//
// SCOPE (deliberate): this run imports only the circuits passed on the CLI (default
// PPT). WPT stays Wikipedia-sourced for now because Tuesday's rounds routine is keyed
// to those tournaments — re-sourcing WPT needs coordinated round re-mapping and is a
// separate step. PREMIER PADEL / CUPRA FIP TOUR are intentionally excluded: the live
// index.json archive already carries the modern FIP/Premier events.
//
//   node scripts/import-fip-circuit.mjs            # PPT 2006-2012 (default)
//   node scripts/import-fip-circuit.mjs PPT 2006 2012
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WPT = join(ROOT, "public/data/archive/wpt.json");
const API = "https://www.padelfip.com/wp-json/fip/v1/circuit-stats";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0 Safari/537.36";

const argv = process.argv.slice(2);
const CIRCUIT = (argv[0] || "PPT").toUpperCase();
const Y0 = +(argv[1] || 2006), Y1 = +(argv[2] || 2012);
const tourTag = CIRCUIT === "PADEL PRO TOUR" ? "PPT" : CIRCUIT; // normalise
// Multi-word circuits ("PREMIER PADEL") would otherwise put a space in every tournament key.
const keyPrefix = tourTag.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const slug = (s) => clean(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const isoDate = (dmy) => { const m = (dmy || "").match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const parseSets = (score) => {
  const out = [];
  for (const tok of clean(score).replace(/\//g, " ").split(/\s+/)) {
    const m = tok.match(/^(\d+)-(\d+)/);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
};
const pair = (a, b) => [a, b].map((p) => clean(p?.name)).filter(Boolean);
const ids = (a, b) => [a, b].map((p) => p?.player_id).filter((x) => x && !/^nd/i.test(x)); // drop "nd.." placeholders

async function fetchYear(year) {
  const res = await fetch(`${API}?year=${year}&limit=500`, { headers: { "user-agent": UA, "referer": "https://www.padelfip.com/ranking-history/", "accept": "application/json" } });
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? rows.filter((r) => (r.circuit || "").toUpperCase() === CIRCUIT) : [];
}

const wpt = JSON.parse(readFileSync(WPT, "utf8"));
// Normalise the legacy Wikipedia tournaments: they're all WPT but carry no explicit
// `tour` field (it used to be inferred in the frontend). Stamp it so the tour filter
// can treat every wpt.json tournament uniformly.
for (const t of wpt.tournaments) if (!t.tour) t.tour = "WPT";

// Idempotent: drop any tournaments we previously imported for this tour, then re-add.
wpt.tournaments = wpt.tournaments.filter((t) => t.tour !== tourTag);

const byKey = new Map();
let rowsSeen = 0;
for (let y = Y0; y <= Y1; y++) {
  const rows = await fetchYear(y);
  rowsSeen += rows.length;
  for (const r of rows) {
    const name = clean(r.tournament);
    if (!name) continue;
    const key = `${keyPrefix}-${y}-${slug(name)}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key, name, year: y, tour: tourTag, circuit: r.circuit,
        city: clean(r.city) || null, country: clean(r.country?.name) || null,
        start: isoDate(r.final_date) || `${y}-01-01`, finals: {},
      });
    }
    const t = byKey.get(key);
    const gender = /female|women/i.test(r.gender) ? "Women" : "Men";
    const winners = pair(r.winner_player, r.winner_partner);
    const runnersUp = pair(r.finalist, r.finalist_partner);
    if (winners.length) {
      t.finals[gender] = {
        winners, runnersUp, score: clean(r.score) || null, sets: parseSets(r.score),
        winnerIds: ids(r.winner_player, r.winner_partner),
        runnerIds: ids(r.finalist, r.finalist_partner),
      };
    }
  }
  await new Promise((res) => setTimeout(res, 300)); // polite
}

const added = [...byKey.values()].filter((t) => Object.keys(t.finals).length);
wpt.tournaments.push(...added);
for (const t of wpt.tournaments) t.start ||= `${t.year}-01-01`;
wpt.tournaments.sort((a, b) => (b.start || "").localeCompare(a.start || ""));
wpt.generatedAt = new Date().toISOString();
// Don't clobber what a previous import recorded — note this circuit alongside it.
wpt.circuitSource = [...new Set([...(wpt.circuitSource || "").split("; ").filter(Boolean),
  `${tourTag} finals from padelfip.com circuit-stats API`])].join("; ");
writeFileSync(WPT, JSON.stringify(wpt, null, 2));

const finals = added.reduce((a, t) => a + Object.keys(t.finals).length, 0);
const yrs = [...new Set(added.map((t) => t.year))].sort();
console.log(`✅ ${tourTag}: ${added.length} tournaments · ${finals} finals across ${yrs[0]}–${yrs[yrs.length - 1]} (from ${rowsSeen} API rows) -> wpt.json`);
