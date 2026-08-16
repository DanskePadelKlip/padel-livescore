// Import the year-end world No.1 pairs from FIP's ranking-history page.
//
//   node scripts/import-fip-no1-history.mjs            # dry run
//   node scripts/import-fip-no1-history.mjs --apply    # write public/data/archive/world-no1.json
//
// This is the deepest history the archive has: 1986 to the present, where the tournament
// data only reaches 2006 and round-level detail 2010. It is also the thinnest — a single
// pair per gender per year, no tournaments and no scores — so it lives in its own small
// file rather than being folded into wpt.json.
//
// FIP names the authority for each year in a trailing column (APA, FEP, Padel Pro Tour,
// World Padel Tour, FIP, or plainly "Historical sources" for 1986-87). That provenance is
// kept per row: the early years are not a ranking in the modern sense and shouldn't be
// presented as if they were.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public/data/archive/world-no1.json");
const URL = "https://www.padelfip.com/ranking-history/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0 Safari/537.36";
const APPLY = process.argv.includes("--apply");

// Node's fetch ignores HTTP(S)_PROXY, so behind a proxying sandbox it fails where curl —
// which reads the same env vars natively — succeeds. Try fetch, fall back once.
async function httpGet(url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" } });
    if (res.ok) return await res.text();
  } catch { /* fall through */ }
  return await new Promise((resolve) => {
    execFile("curl", ["-sL", "-m", "45", "-A", UA, url], { maxBuffer: 32 << 20 },
      (err, stdout) => resolve(err ? "" : stdout));
  });
}

const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
// The country rides in an <img>: alt="ARG flag" for the code, the upload filename for the name.
const country = (cell) => {
  const code = cell.match(/alt=['"]([A-Za-z]{2,3})\s*flag['"]/i)?.[1] || null;
  const raw = cell.match(/uploads\/[^'"]*?\/([A-Za-z_]+?)_Fip/i)?.[1] || null;
  return { code: code ? code.toUpperCase() : null, name: raw ? raw.replace(/_/g, " ") : null };
};

const html = await httpGet(URL);
if (!html) { console.error("could not fetch the ranking-history page"); process.exit(1); }
const table = html.match(/<table[\s\S]*?<\/table>/i)?.[0];
if (!table) { console.error("no table on the page — layout changed?"); process.exit(1); }

const rows = [];
for (const tr of [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0])) {
  const cells = [...tr.matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((m) => m[0]);
  if (cells.length < 9) continue;
  const year = +text(cells[0]);
  if (!Number.isFinite(year) || year < 1900) continue;      // skips the header row
  const pair = (a, b) => [[text(cells[a]), country(cells[a + 1])], [text(cells[b]), country(cells[b + 1])]]
    .filter(([n]) => n)
    .map(([name, c]) => ({ name, country: c.name, code: c.code }));
  const men = pair(1, 3), women = pair(5, 7);
  rows.push({
    year,
    source: text(cells[9] || ""),
    // A year can legitimately have one gender and not the other: the women's game has no
    // recorded No.1 before 1990.
    ...(men.length ? { Men: men } : {}),
    ...(women.length ? { Women: women } : {}),
  });
}
rows.sort((a, b) => b.year - a.year);

const withMen = rows.filter((r) => r.Men).length, withWomen = rows.filter((r) => r.Women).length;
console.log(`${rows.length} years parsed: ${rows[rows.length - 1]?.year}–${rows[0]?.year}`);
console.log(`  men's No.1 in ${withMen} years · women's in ${withWomen}`);
console.log(`  authorities: ${[...new Set(rows.map((r) => r.source))].filter(Boolean).length} distinct`);
const partial = rows.filter((r) => (r.Men && r.Men.length !== 2) || (r.Women && r.Women.length !== 2));
if (partial.length) console.log(`  ! ${partial.length} row(s) with an incomplete pair: ${partial.map((r) => r.year).join(", ")}`);

if (!APPLY) { console.log("\n(dry run — nothing written. re-run with --apply)"); process.exit(0); }
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: URL,
  note: "Year-end world No.1 pair per gender. The authority differs by era and is given per row; 1986-87 are FIP's own \"Historical sources\" rather than a published ranking.",
  count: rows.length,
  years: rows,
}, null, 2));
console.log(`\n✅ wrote ${OUT}`);
