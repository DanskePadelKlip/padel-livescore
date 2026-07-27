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
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "data", "archive", "wpt.json");
const UA = "Mozilla/5.0 (PadelTicker WPT import; +https://padelticker.com)";
const ALL_YEARS = [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const slug = (s) =>
  clean(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// "19 March – 24 March" | "5 December" -> ISO start (year-MM-DD), first date found.
function startISO(dateRaw, year) {
  const m = clean(dateRaw).match(/(\d{1,2})\s+([A-Za-z]+)/);
  if (!m) return `${year}-01-01`;
  const mo = MONTHS[m[2].toLowerCase()];
  return mo ? `${year}-${String(mo).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}` : `${year}-01-01`;
}

const stripCites = (s) => clean(s).replace(/\[\d+\]/g, "").trim(); // drop "[129]" footnotes

// "6–1 / 7–6" | "4–6 / 6–1 / 6-4" -> [["6","1"],["7","6"],…]. Tolerates en/em dashes,
// tiebreak parens "7–6(5)" (kept on the games digit's side as the source shows it).
function parseSets(score) {
  const out = [];
  for (const part of stripCites(score).split(/\s*\/\s*/)) {
    const m = part.match(/(\d+)\s*[–—-]\s*(\d+)/);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

// Pull the two players from a pair cell. Each player is prefixed by a `.flagicon`
// span (their country) whether or not the name is wikilinked, so split on those
// boundaries — robust even when Wikipedia didn't link a name (which breaks a pure
// anchor split). Fall back to anchors, then the raw text as a single pair string.
function pairPlayers(cell) {
  const flags = [...cell.querySelectorAll(".flagicon")];
  if (flags.length >= 2) {
    const names = [];
    for (let i = 0; i < flags.length; i++) {
      const stop = flags[i + 1] || null;
      let node = flags[i].nextSibling, txt = "";
      while (node && node !== stop) { txt += node.textContent || ""; node = node.nextSibling; }
      const n = stripCites(txt);
      if (n) names.push(n);
    }
    if (names.length >= 2) return names.slice(0, 2);
  }
  const anchors = [...cell.querySelectorAll("a")]
    .map((a) => stripCites(a.textContent))
    .filter((t) => t && !/^\[/.test(t) && !/^\d+$/.test(t));
  if (anchors.length) return anchors;
  const txt = stripCites(cell.textContent);
  return txt ? [txt] : [];
}

async function fetchPage(slugName, tries = 4) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/html/${slugName}`;
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

function parseYear(html, year) {
  const { document } = parseHTML(html);
  const tables = [...document.querySelectorAll("table")];

  // --- schedule table: header has City + Country ---
  const schedule = new Map(); // slug(name) -> { city, country, start }
  for (const t of tables) {
    const h = headerCells(t);
    if (!(h.some((x) => x.includes("city")) && h.some((x) => x.includes("countr")))) continue;
    const dateIdx = h.findIndex((x) => x.includes("date"));
    for (const tr of [...t.querySelectorAll("tr")].slice(1)) {
      const c = [...tr.querySelectorAll("th,td")];
      if (c.length < 3) continue;
      const name = stripCites(c[0].textContent);
      if (!name) continue;
      schedule.set(slug(name), {
        city: clean(c[1]?.textContent) || null,
        country: clean(c[2]?.textContent) || null,
        start: startISO(dateIdx >= 0 ? c[dateIdx]?.textContent : "", year),
      });
    }
    break; // one schedule table per season
  }

  // --- results tables: header has Winners + Runners-up ---
  const resultTables = tables.filter((t) => {
    const h = headerCells(t);
    return h.some((x) => x.includes("winner")) && h.some((x) => x.includes("runner"));
  });

  const tourneys = new Map(); // slug -> { name, city, country, start, year, finals:{} }
  resultTables.forEach((t, i) => {
    const gender = genderFor(t, i);
    for (const tr of [...t.querySelectorAll("tr")].slice(1)) {
      const c = [...tr.querySelectorAll("th,td")];
      if (c.length < 3) continue;
      const name = stripCites(c[0].textContent);
      if (!name) continue;
      const winners = pairPlayers(c[1]);
      const runnersUp = pairPlayers(c[2]);
      const score = stripCites(c[3]?.textContent) || null;
      if (!winners.length) continue;

      const key = slug(name);
      if (!tourneys.has(key)) {
        const s = schedule.get(key) || {};
        tourneys.set(key, {
          key: `wpt-${year}-${key}`, name, year,
          city: s.city || null, country: s.country || null, start: s.start || `${year}-01-01`,
          finals: {},
        });
      }
      tourneys.get(key).finals[gender] = {
        winners, runnersUp, score, sets: parseSets(score),
      };
    }
  });

  return [...tourneys.values()];
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => /^\d{4}$/.test(a)).map(Number);
  const years = argv.length ? argv : ALL_YEARS;
  const all = [];
  for (const y of years) {
    const html = await fetchPage(`${y}_World_Padel_Tour`);
    if (!html) { console.log(`  ${y}: page unavailable (404/rate-limited) — skipped`); continue; }
    const list = parseYear(html, y);
    console.log(`  ${y}: ${list.length} tournaments (${list.filter((t) => t.finals.Men).length} men, ${list.filter((t) => t.finals.Women).length} women)`);
    all.push(...list);
    await new Promise((r) => setTimeout(r, 1200)); // be polite to Wikipedia's REST API
  }
  all.sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: "Wikipedia — {year} World Padel Tour season articles (finals only)",
    count: all.length,
    tournaments: all,
  }, null, 2));
  console.log(`\n✅ ${all.length} WPT tournaments across ${years.length} seasons -> ${OUT}`);
}

main();
