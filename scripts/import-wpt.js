// One-off / re-runnable importer for World Padel Tour (WPT) history.
//
// WPT (2013–2023) ran on its own now-dead platform and was never a live source
// here — but Wikipedia's "{year}_World_Padel_Tour" season articles carry, per
// tournament, the MEN's and WOMEN's FINAL (champions, runners-up, score) plus a
// schedule table (city, country, date). That's finals-only, not full draws, but
// it's the most complete free WPT record. This parses those pages (server-rendered
// HTML, same mechanism as calendar-refresh.js) into:
//
//   public/data/archive/wpt.json  — { generatedAt, source, count, tournaments:[…] }
//
// The site's Results/archive view loads this ADDITIVELY, alongside the FIP+RankedIn
// index.json. It is deliberately NOT merged into index.json: that file is
// regenerated wholesale by padel-db/export_archive.py, which would wipe injected
// rows. Keeping WPT in its own file means the export pipeline can never clobber it.
//
//   node scripts/import-wpt.js            # all years
//   node scripts/import-wpt.js 2019 2022  # specific years

import { parseHTML } from "linkedom";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "data", "archive", "wpt.json");
const UA = "Mozilla/5.0 (PadelTicker WPT import; +https://padelticker.com)";
const ALL_YEARS = [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
// ES is richer for the early women's seasons, so both are parsed and merged. NOTE the
// title patterns differ: en.wikipedia uses "2015 World Padel Tour", es.wikipedia uses
// "World Padel Tour 2015" — using the EN pattern on ES 404s on every season.
const LANGS = [
  { lang: "en", title: (y) => `${y}_World_Padel_Tour` },
  { lang: "es", title: (y) => `World_Padel_Tour_${y}` },
];

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  // Spanish (es.wikipedia writes "23 de marzo al 29 de marzo")
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

// Text that records a non-event rather than a result ("Cancelado", "No disputado",
// "No disputado en categoría femenina", "No se disputó", "Not held"…).
const NOT_PLAYED = /cancel|suspend|aplazad|not held|no\s+(se\s+)?disput/i;

// "España España" (flag alt + name) -> "España"; also trims stray repeats.
function dedupeCountry(s) {
  const v = clean(s);
  if (!v) return null;
  const half = v.slice(0, Math.floor(v.length / 2)).trim();
  if (half && v === `${half} ${half}`) return half;
  const w = v.split(" ");
  if (w.length % 2 === 0) {
    const a = w.slice(0, w.length / 2).join(" "), b = w.slice(w.length / 2).join(" ");
    if (a === b) return a;
  }
  return v;
}

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const slug = (s) =>
  clean(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// "19 March – 24 March" | "5 December" | "23 de marzo al 29 de marzo" -> ISO start.
function startISO(dateRaw, year) {
  const m = clean(dateRaw).match(/(\d{1,2})\s+(?:de\s+)?([A-Za-zÁÉÍÓÚáéíóú]+)/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  return mo ? `${year}-${String(mo).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}` : null;
}

// drop Wikipedia footnote markers: "[129]", "[a]", "[A]", "[nb 1]"
const stripCites = (s) => clean(s).replace(/\[(?:\d+|[a-z]|nb ?\d+)\]/gi, "").trim();

// "6–1 / 7–6" | "4–6 / 6–1 / 6-4" -> [["6","1"],["7","6"],…]. Tolerates en/em dashes,
// tiebreak parens "7–6(5)" (kept on the games digit's side as the source shows it).
// Sets are separated by "/" (EN) or "," / " y " (ES: "4-6, 6-2 y 7-5").
function parseSets(score) {
  const out = [];
  for (const part of stripCites(score).split(/\s*(?:\/|,|\sy\s|\sand\s)\s*/i)) {
    const m = part.match(/(\d+)\s*[–—-]\s*(\d+)/);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

// Pull the two players from a pair cell. Each player is prefixed by a `.flagicon`
// span (their country) whether or not the name is wikilinked, so split on those
// boundaries — robust even when Wikipedia didn't link a name (which breaks a pure
// anchor split). Fall back to anchors, then the raw text as a single pair string.
// Trailing/leading conjunction left over when splitting on flag boundaries:
// es.wikipedia writes "Paquito Navarro y Matías Díaz", so the first slice ends " y ".
const CONJ = /^(?:y|and|&|e)\s+|\s+(?:y|and|&|e)$/gi;
const tidyName = (s) => stripCites(s).replace(CONJ, "").trim();

function pairPlayers(cell) {
  const flags = [...cell.querySelectorAll(".flagicon")];
  if (flags.length >= 2) {
    const names = [];
    for (let i = 0; i < flags.length; i++) {
      const stop = flags[i + 1] || null;
      let node = flags[i].nextSibling, txt = "";
      while (node && node !== stop) { txt += node.textContent || ""; node = node.nextSibling; }
      const n = tidyName(txt);
      if (n) names.push(n);
    }
    if (names.length >= 2) return names.slice(0, 2);
  }
  const anchors = [...cell.querySelectorAll("a")]
    .map((a) => tidyName(a.textContent))
    .filter((t) => t && !/^\[/.test(t) && !/^\d+$/.test(t));
  if (anchors.length >= 2) return anchors.slice(0, 2);
  // last resort: split the raw text on the conjunction ("A y B" / "A and B")
  const txt = stripCites(cell.textContent);
  if (!txt) return [];
  const parts = txt.split(/\s+(?:y|and|&)\s+/i).map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts.slice(0, 2) : (anchors.length ? anchors : [txt]);
}

async function fetchPage(lang, slugName, tries = 4) {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/html/${slugName}`;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) }).catch((e) => ({ ok: false, status: 0, _e: e }));
    if (res.ok) return res.text();
    if (res.status === 404) return null;
    // 429 / 5xx / network — back off and retry
    const wait = 1500 * (i + 1);
    if (i < tries - 1) await new Promise((r) => setTimeout(r, wait));
    else return null;
  }
  return null;
}

// classify a results table by its nearest preceding heading (Male/Female);
// fall back to order (first results table = men).
function genderFor(table, orderIndex) {
  let el = table.previousElementSibling, hops = 0;
  while (el && hops < 12) {
    if (/^H[234]$/.test(el.tagName)) {
      const h = clean(el.textContent).toLowerCase();
      if (/female|women|femenin/.test(h)) return "Women";
      if (/\bmale\b|\bmen\b|masculin/.test(h)) return "Men";
    }
    el = el.previousElementSibling; hops++;
  }
  return orderIndex === 0 ? "Men" : "Women";
}

function headerCells(table) {
  const first = table.querySelector("tr");
  return [...(first?.querySelectorAll("th,td") || [])].map((c) => clean(c.textContent).toLowerCase());
}

// Header vocabulary, EN + ES. The Spanish articles are noticeably more complete for
// the early women's seasons (2014: 16 finals vs 9 on EN; 2015: 17 vs 10), so both
// languages are parsed and merged.
const HDR = {
  city: ["city", "ciudad"],
  country: ["countr", "país", "pais"],
  date: ["date", "fecha"],
  winner: ["winner", "ganador", "campeon", "campeón"],
  runner: ["runner", "finalista", "subcampeon", "subcampeón"],
  rank: ["pos.", "pos", "ranking", "puesto"],
  name: ["name", "nombre", "jugador", "pareja"],
  points: ["points", "puntos"],
};
const has = (h, keys) => h.some((x) => keys.some((k) => x.includes(k)));

function parseYear(html, year) {
  const { document } = parseHTML(html);
  const tables = [...document.querySelectorAll("table")];

  // --- schedule table: header has City + Country ---
  const schedule = new Map(); // slug(name) -> { name, city, country, start }
  for (const t of tables) {
    const h = headerCells(t);
    if (!(has(h, HDR.city) && has(h, HDR.country))) continue;
    const dateIdx = h.findIndex((x) => HDR.date.some((k) => x.includes(k)));
    for (const tr of [...t.querySelectorAll("tr")].slice(1)) {
      const c = [...tr.querySelectorAll("th,td")];
      if (c.length < 3) continue;
      const name = stripCites(c[0].textContent);
      if (!name) continue;
      schedule.set(slug(name), {
        name,
        city: dedupeCountry(c[1]?.textContent),
        country: dedupeCountry(c[2]?.textContent),
        start: startISO(dateIdx >= 0 ? c[dateIdx]?.textContent : "", year),
      });
    }
    break; // one schedule table per season
  }

  // es.wikipedia's RESULTS tables use short names ("Barcelona", "La Palma") while its
  // CALENDAR table carries the full one ("Barcelona Master", "Isla de La Palma Open").
  // Resolve short -> full so a season merges with the English article instead of
  // duplicating every event under two names.
  const canonical = (name) => {
    const s = slug(name);
    if (schedule.has(s)) return schedule.get(s).name;
    let best = null;
    for (const [ks, v] of schedule) {
      if (ks === s || ks.includes(s) || s.includes(ks)) {
        if (!best || ks.length > slug(best).length) best = v.name;
      }
    }
    return best || name;
  };

  // --- results tables: first column is the tournament, plus Winners + Runners-up.
  // The first-column check matters: es.wikipedia's end-of-season RANKING tables also
  // carry "Vencedor"/"Finalista" columns (titles won / finals reached), so matching on
  // those alone pulled ranking rows in as if they were tournaments.
  const isRanking = (h) => has(h, HDR.rank) && has(h, HDR.name) && has(h, HDR.points);
  const resultTables = tables.filter((t) => {
    const h = headerCells(t);
    return has(h, HDR.winner) && has(h, HDR.runner) && !isRanking(h) &&
      (h[0] || "").match(/torneo|tournament|tournamnet|prueba|evento/);
  });

  const tourneys = new Map(); // slug -> { name, city, country, start, year, finals:{} }
  resultTables.forEach((t, i) => {
    const gender = genderFor(t, i);
    for (const tr of [...t.querySelectorAll("tr")].slice(1)) {
      const c = [...tr.querySelectorAll("th,td")];
      if (c.length < 3) continue;
      const rawName = stripCites(c[0].textContent);
      if (!rawName) continue;
      // "Cancelado" / "No se disputó" rows record a non-event, not a champion
      if (NOT_PLAYED.test(rawName) || NOT_PLAYED.test(clean(c[1]?.textContent))) continue;
      const name = canonical(rawName);
      const winners = pairPlayers(c[1]);
      const runnersUp = pairPlayers(c[2]);
      const score = stripCites(c[3]?.textContent) || null;
      if (!winners.length) continue;

      const key = slug(name);
      if (!tourneys.has(key)) {
        const s = schedule.get(key) || {};
        tourneys.set(key, {
          key: `wpt-${year}-${key}`, name, year,
          city: s.city || null, country: s.country || null, start: s.start || null,
          finals: {},
        });
      }
      tourneys.get(key).finals[gender] = {
        winners, runnersUp, score, sets: parseSets(score),
      };
    }
  });

  // --- end-of-season ranking tables ---
  // These have a TWO-ROW header: a title row ("2019 Men's Ranking", colspan 4) then
  // the real column header (Pos. | Name | Country | Points). So find the header row
  // by scanning for one whose cells look like column labels, and read data after it.
  const rowCells = (tr) => [...tr.querySelectorAll("th,td")].map((c) => clean(c.textContent).toLowerCase());
  const rankings = {};
  tables.forEach((t, i) => {
    const trs = [...t.querySelectorAll("tr")];
    const hIdx = trs.findIndex((tr) => {
      const c = rowCells(tr);
      return c.length >= 3 && has(c, HDR.rank) && has(c, HDR.name) && has(c, HDR.points);
    });
    if (hIdx < 0) return;
    const h = rowCells(trs[hIdx]);
    const iRank = h.findIndex((x) => HDR.rank.some((k) => x.includes(k)));
    const iName = h.findIndex((x) => HDR.name.some((k) => x.includes(k)));
    const iPts = h.findIndex((x) => HDR.points.some((k) => x.includes(k)));
    const iCountry = h.findIndex((x) => HDR.country.some((k) => x.includes(k)));
    const gender = genderFor(t, i);
    const rows = [];
    for (const tr of trs.slice(hIdx + 1)) {
      const c = [...tr.querySelectorAll("th,td")];
      if (c.length < 2) continue;
      // A rowspan'd partner row omits the leading rank/country cells, so it's shorter;
      // read from the END (name is always followed by country, then points on rank rows).
      const short = c.length < h.length;
      const name = tidyName((short ? c[0] : c[iName])?.textContent);
      if (!name || /^\d+$/.test(name)) continue;
      const rank = parseInt(stripCites((short ? "" : c[iRank]?.textContent)).replace(/\D/g, ""), 10);
      const ptsRaw = stripCites((short ? c[c.length - 1] : c[iPts])?.textContent).replace(/[^\d]/g, "");
      rows.push({
        rank: Number.isFinite(rank) ? rank : (rows[rows.length - 1]?.rank ?? null),
        name,
        country: dedupeCountry((short ? c[1] : c[iCountry])?.textContent),
        points: ptsRaw ? +ptsRaw : (short ? rows[rows.length - 1]?.points ?? null : null),
      });
    }
    if (rows.length && (!rankings[gender] || rows.length > rankings[gender].length)) rankings[gender] = rows;
  });

  return { tournaments: [...tourneys.values()], rankings };
}

// Merge a parsed season from another language into the accumulator: fill in
// tournaments/finals we don't have yet, and keep the more complete variant of a
// final we do (a proper 2v2 with a score beats a partial one).
const completeness = (f) =>
  (f?.winners?.length === 2 ? 2 : f?.winners?.length ? 1 : 0) +
  (f?.runnersUp?.length === 2 ? 2 : f?.runnersUp?.length ? 1 : 0) +
  (f?.sets?.length ? 1 : 0);

const dayDiff = (a, b) => Math.abs((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);

// Fold one season's tournaments into the accumulator. English is the SPINE: it names
// events consistently ("Las Rozas Open") where Spanish often uses just the city
// ("Las Rozas de Madrid"), so the two can't be joined on name. Instead a later
// language matches an existing event by slug or by START DATE (same week), and is
// only used to FILL what's missing — chiefly the early women's finals, which the
// English articles barely cover. Anything that matches nothing is reported, not
// appended, so we never invent duplicate events.
function mergeSeason(into, parsed, { spine }) {
  let filled = 0, added = 0, unmatched = 0;
  for (const t of parsed.tournaments) {
    let cur = into.get(t.key);
    if (!cur && !spine && t.start) {
      for (const c of into.values()) {
        if (c.start && dayDiff(c.start, t.start) <= 4) { cur = c; break; }
      }
    }
    if (!cur) {
      if (spine) { into.set(t.key, t); added++; } else unmatched++;
      continue;
    }
    cur.city ||= t.city; cur.country ||= t.country; cur.start ||= t.start;
    for (const [g, f] of Object.entries(t.finals)) {
      if (!cur.finals[g] || completeness(f) > completeness(cur.finals[g])) {
        if (!cur.finals[g]) filled++;
        cur.finals[g] = f;
      }
    }
  }
  return { filled, added, unmatched };
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => /^\d{4}$/.test(a)).map(Number);
  const years = argv.length ? argv : ALL_YEARS;
  const all = [];
  const seasonRankings = [];
  for (const y of years) {
    const byKey = new Map();
    const ranks = {};
    const notes = [];
    for (const [i, { lang, title }] of LANGS.entries()) {
      const html = await fetchPage(lang, title(y));
      if (!html) { console.log(`  ${y} [${lang}]: unavailable (404/rate-limited)`); continue; }
      const parsed = parseYear(html, y);
      const r = mergeSeason(byKey, parsed, { spine: i === 0 });
      if (i > 0) notes.push(`${lang}: +${r.filled} finals${r.unmatched ? `, ${r.unmatched} unmatched` : ""}`);
      for (const [g, rows] of Object.entries(parsed.rankings)) {
        if (!ranks[g] || rows.length > ranks[g].length) ranks[g] = rows;
      }
      await new Promise((r) => setTimeout(r, 900)); // be polite to Wikipedia's REST API
    }
    const list = [...byKey.values()];
    const nR = Object.values(ranks).reduce((a, r) => a + r.length, 0);
    console.log(`  ${y}: ${list.length} tournaments (${list.filter((t) => t.finals.Men).length}M/${list.filter((t) => t.finals.Women).length}W)${nR ? ` · ${nR} rank rows` : ""}${notes.length ? ` · ${notes.join("; ")}` : ""}`);
    all.push(...list);
    for (const [gender, rows] of Object.entries(ranks)) seasonRankings.push({ year: y, gender, rows });
  }
  for (const t of all) t.start ||= `${t.year}-01-01`; // keep the archive sortable
  all.sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  seasonRankings.sort((a, b) => b.year - a.year || a.gender.localeCompare(b.gender));

  // PRESERVE deeper rounds. This importer only knows finals + rankings (Wikipedia),
  // but scripts/wpt-rounds-merge.mjs later attaches a `rounds` array (semis/quarters,
  // from news extraction) per tournament. Carry those forward so re-running THIS
  // importer doesn't silently wipe them — they can only be regenerated by re-running
  // the whole news-extraction pipeline.
  try {
    const prev = JSON.parse(readFileSync(OUT, "utf8"));
    const prevRounds = new Map((prev.tournaments || []).filter((t) => t.rounds?.length).map((t) => [t.key, t.rounds]));
    let kept = 0;
    for (const t of all) { const r = prevRounds.get(t.key); if (r) { t.rounds = r; kept += r.length; } }
    if (kept) console.log(`  preserved ${kept} existing deeper-round records from ${prevRounds.size} tournament(s)`);
  } catch { /* no existing file — nothing to preserve */ }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: "Wikipedia — '{year} World Padel Tour' season articles (EN + ES), finals + end-of-season rankings",
    count: all.length,
    tournaments: all,
    rankings: seasonRankings,
  }, null, 2));
  const finals = all.reduce((a, t) => a + Object.keys(t.finals).length, 0);
  const rrows = seasonRankings.reduce((a, r) => a + r.rows.length, 0);
  console.log(`\n✅ ${all.length} tournaments · ${finals} finals · ${rrows} ranking rows across ${years.length} seasons -> ${OUT}`);
}

main();
