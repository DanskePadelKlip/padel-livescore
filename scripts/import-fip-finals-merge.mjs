// Fill gaps in wpt.json's FINALS from FIP's structured circuit-stats API — without
// disturbing the tournaments themselves. Unlike import-fip-circuit.mjs (which owns the
// PPT tournaments and rebuilds them wholesale), this script only ever ADDS to
// tournaments that already exist:
//
//   • a missing gender's final (the big win: ~132 tournaments have no Women's final,
//     because the Wikipedia season articles cover the women's draw patchily)
//   • FIP player ids on finals that have none (the Wikipedia-sourced WPT finals carry
//     names only, so nothing can be joined across circuits or tracked per player)
//
// It never renames, re-keys, deletes or reorders a tournament, because the `rounds`
// arrays added by the news extraction hang off those keys. It never overwrites an
// existing final either: Wikipedia stays authoritative, so a disagreement is REPORTED
// as a conflict for a human to adjudicate, not silently resolved.
//
//   node scripts/import-fip-finals-merge.mjs                      # dry run, WPT 2013-2023
//   node scripts/import-fip-finals-merge.mjs --apply              # actually write wpt.json
//   node scripts/import-fip-finals-merge.mjs --circuit PPT --years 2006 2012
//   node scripts/import-fip-finals-merge.mjs --raw-out scratch/fip-wpt.json   # save API rows
//   node scripts/import-fip-finals-merge.mjs --from-raw scratch/fip-wpt.json  # replay offline
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WPT = join(ROOT, "public/data/archive/wpt.json");
const API = "https://www.padelfip.com/wp-json/fip/v1/circuit-stats";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0 Safari/537.36";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const APPLY = has("apply");
const CIRCUIT = (flag("circuit", "WPT")).toUpperCase();
const yearsAt = argv.indexOf("--years");
const Y0 = +(yearsAt >= 0 ? argv[yearsAt + 1] : 0) || (CIRCUIT === "PPT" ? 2006 : 2013);
const Y1 = +(yearsAt >= 0 ? argv[yearsAt + 2] : 0) || (CIRCUIT === "PPT" ? 2012 : 2023);
const RAW_OUT = flag("raw-out");
const FROM_RAW = flag("from-raw");

// --- helpers (same normalisation as import-fip-circuit.mjs, so keys/scores stay consistent)
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const norm = (s) => clean(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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
const ids = (a, b) => [a, b].map((p) => p?.player_id).filter((x) => x && !/^nd/i.test(x));
const nameKey = (arr) => (arr || []).map(norm).sort().join("+");
const days = (a, b) => Math.abs(new Date(a + "T12:00:00Z") - new Date(b + "T12:00:00Z")) / 864e5;

// Words that appear in so many tournament names they carry no matching signal.
const STOP = new Set(["open", "master", "masters", "final", "finals", "padel", "tour", "world", "international",
  "challenger", "cup", "trophy", "de", "del", "la", "el", "of", "the", "estrella", "damm", "cerveza"]);
const tokens = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
const overlap = (a, b) => {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
};

async function fetchYear(year) {
  const url = `${API}?year=${year}&limit=500`;
  const res = await fetch(url, { headers: { "user-agent": UA, referer: "https://www.padelfip.com/ranking-history/", accept: "application/json" } });
  if (!res.ok) { console.log(`  ! ${year}: HTTP ${res.status}`); return []; }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

// --- 1. gather FIP rows (live, or replayed from a saved dump)
let rows = [];
if (FROM_RAW) {
  rows = JSON.parse(readFileSync(join(ROOT, FROM_RAW), "utf8"));
  console.log(`replaying ${rows.length} saved API rows from ${FROM_RAW}`);
} else {
  for (let y = Y0; y <= Y1; y++) {
    const got = await fetchYear(y);
    rows.push(...got);
    console.log(`  ${y}: ${got.length} rows`);
    await new Promise((r) => setTimeout(r, 300)); // polite
  }
  if (RAW_OUT) {
    mkdirSync(dirname(join(ROOT, RAW_OUT)), { recursive: true });
    writeFileSync(join(ROOT, RAW_OUT), JSON.stringify(rows, null, 2));
    console.log(`saved ${rows.length} raw rows -> ${RAW_OUT}`);
  }
}
const circuitRows = rows.filter((r) => (r.circuit || "").toUpperCase() === CIRCUIT && +r.year >= Y0 && +r.year <= Y1);
console.log(`\n${circuitRows.length} ${CIRCUIT} rows in ${Y0}-${Y1} (of ${rows.length} fetched)\n`);

// --- 2. match each row to an EXISTING tournament (never create one here)
const wpt = JSON.parse(readFileSync(WPT, "utf8"));
const byYear = new Map();
for (const t of wpt.tournaments) {
  if (!byYear.has(t.year)) byYear.set(t.year, []);
  byYear.get(t.year).push(t);
}

// Score a candidate: city agreement and name overlap are the real signals; the final
// date only breaks ties, since Wikipedia's `start` is the tournament start and FIP's
// `final_date` is its last day (typically 4-7 days apart).
function match(row) {
  const y = +row.year;
  const cands = byYear.get(y) || [];
  const rowCity = norm(row.city), rowName = clean(row.tournament), rowDate = isoDate(row.final_date);
  let best = null, bestScore = 0;
  for (const t of cands) {
    let s = 0;
    const tCity = norm((t.city || "").split("(")[0]);
    if (rowCity && tCity && (tCity === rowCity || tCity.includes(rowCity) || rowCity.includes(tCity))) s += 3;
    s += 3 * overlap(rowName, t.name || "");
    if (rowDate && t.start) { const d = days(rowDate, t.start); if (d <= 10) s += 1.5 - d / 10; }
    if (s > bestScore) { bestScore = s; best = t; }
  }
  return bestScore >= 2.5 ? { t: best, score: bestScore } : null; // below this it's a guess, so don't
}

const stats = { filled: 0, idsAdded: 0, conflicts: [], unmatched: [], alreadyOk: 0 };

for (const row of circuitRows) {
  const m = match(row);
  if (!m) { stats.unmatched.push(`${row.year} ${clean(row.tournament)} (${clean(row.city)}) ${clean(row.gender)}`); continue; }
  const t = m.t;
  const gender = /female|women|dam/i.test(row.gender || "") ? "Women" : "Men";
  const winners = pair(row.winner_player, row.winner_partner);
  const runnersUp = pair(row.finalist, row.finalist_partner);
  if (winners.length !== 2) continue; // an unusable row: don't let it create a half-final

  const existing = t.finals?.[gender];
  const winnerIds = ids(row.winner_player, row.winner_partner);
  const runnerIds = ids(row.finalist, row.finalist_partner);

  if (!existing) {
    (t.finals ||= {})[gender] = {
      winners, runnersUp, score: clean(row.score) || null, sets: parseSets(row.score),
      winnerIds, runnerIds, source: "FIP",
    };
    stats.filled++;
    continue;
  }

  // Tournament already has this final (from Wikipedia). Keep it authoritative, but
  // enrich it with the player ids it never had — and flag any real disagreement.
  if (nameKey(existing.winners) === nameKey(winners)) {
    let touched = false;
    if (!existing.winnerIds?.length && winnerIds.length) { existing.winnerIds = winnerIds; touched = true; }
    if (!existing.runnerIds?.length && runnerIds.length) { existing.runnerIds = runnerIds; touched = true; }
    if (touched) stats.idsAdded++; else stats.alreadyOk++;
  } else {
    stats.conflicts.push(`${t.year} ${t.name} ${gender}: wiki=${(existing.winners || []).join("/")} · fip=${winners.join("/")}`);
  }
}

// --- 3. report, then write only if asked
console.log(`filled missing finals : ${stats.filled}`);
console.log(`finals given FIP ids  : ${stats.idsAdded}`);
console.log(`already complete      : ${stats.alreadyOk}`);
console.log(`conflicts (NOT changed): ${stats.conflicts.length}`);
stats.conflicts.slice(0, 15).forEach((c) => console.log(`  ⚠ ${c}`));
if (stats.conflicts.length > 15) console.log(`  … and ${stats.conflicts.length - 15} more`);
console.log(`unmatched FIP rows    : ${stats.unmatched.length}`);
stats.unmatched.slice(0, 15).forEach((u) => console.log(`  · ${u}`));
if (stats.unmatched.length > 15) console.log(`  … and ${stats.unmatched.length - 15} more`);

const womenLeft = wpt.tournaments.filter((t) => (t.tour === CIRCUIT || (CIRCUIT === "WPT" && !t.tour)) && t.year >= Y0 && t.year <= Y1 && !t.finals?.Women).length;
console.log(`\n${CIRCUIT} ${Y0}-${Y1} tournaments still missing a Women's final: ${womenLeft}`);

if (!APPLY) {
  console.log(`\n(dry run — nothing written. re-run with --apply to save)`);
} else {
  wpt.generatedAt = new Date().toISOString();
  wpt.circuitSource = `PPT finals from padelfip.com circuit-stats API; WPT finals from Wikipedia, gap-filled + player-id enriched from the same FIP API`;
  writeFileSync(WPT, JSON.stringify(wpt, null, 2));
  console.log(`\n✅ wrote wpt.json (+${stats.filled} finals, +${stats.idsAdded} id-enriched)`);
}
