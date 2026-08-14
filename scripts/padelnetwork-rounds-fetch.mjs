// Padelnetwork round-results — fetch + parse the tournament BRACKETS ("cuadros") that
// padelnetwork.com has published since 2010, into the same match shape the news-extraction
// pipeline produces. This is a structured source: every match in the draw is a table cell,
// so unlike the French-prose route (which yielded ~10 usable rounds across 2014-2017) a whole
// season parses deterministically, both genders, including the qualifying draws.
//
//   node scripts/padelnetwork-rounds-fetch.mjs 2015          -> scratch/pn-rounds-2015.json
//   node scripts/padelnetwork-rounds-fetch.mjs 2013 2018     (inclusive range)
//   node scripts/padelnetwork-rounds-fetch.mjs 2015 --no-previa
//
// Layout: /wpt/{year}/ lists the season's tournaments; each tournament page links
// /cuadro/{masculino|femenino}/ plus /previa/ and /preprevia/ qualifying draws. A draw is one
// big <table> whose header row names the rounds; column N holds round N's participants, and
// the pair that reappears in column N+1 won that match. PPT years live under /ppt/{year}/ with
// an extra country segment.
//
// Fetched HTML is cached under scratch/pn-cache/ so re-parsing never re-hits the site; the
// site blocks ia_archiver, so there is no Wayback copy to fall back on if it ever goes away.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "scratch/pn-cache");
const BASE = "https://www.padelnetwork.com";
// robots.txt disallows several default client UAs by name (Wget, Python-urllib, Go-http-client),
// so identify the project honestly rather than spoofing a browser.
const UA = "PadelTicker-archive/1.0 (+https://github.com/DanskePadelKlip/padel-livescore)";

const argv = process.argv.slice(2);
const years = argv.filter((a) => /^\d{4}$/.test(a)).map(Number);
const Y0 = years[0] || 2015, Y1 = years[1] || years[0] || 2015;
const WANT_PREVIA = !argv.includes("--no-previa");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Node's fetch ignores HTTP(S)_PROXY, so behind a proxying sandbox every request fails while
// curl — which reads the same env vars natively — succeeds. Rather than make the caller know
// which world they're in, try fetch and fall back to curl once, then remember the choice.
let useCurl = false;
async function httpGet(url) {
  if (!useCurl) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" } });
      if (res.ok) return await res.text();
      if (res.status !== 403) return "";
    } catch { /* fall through */ }
    useCurl = true;
    console.log("  (direct fetch blocked — falling back to curl for the rest of this run)");
  }
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve) => {
    execFile("curl", ["-sL", "-m", "45", "-A", UA, url], { maxBuffer: 32 << 20 },
      (err, stdout) => resolve(err ? "" : stdout));
  });
}

async function get(path) {
  const file = join(CACHE, path.replace(/[^a-z0-9]+/gi, "_") + ".html");
  if (existsSync(file)) return readFileSync(file, "utf8");
  const body = await httpGet(BASE + path);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, body);
  await sleep(1100); // ~1 req/s: the site is a single owner's IIS box, don't hammer it
  return body;
}

// --- HTML helpers -----------------------------------------------------------
const ENT = { nbsp: " ", ordm: "º", aacute: "á", eacute: "é", iacute: "í", oacute: "ó",
  uacute: "ú", ntilde: "ñ", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  Ntilde: "Ñ", amp: "&", quot: '"', uuml: "ü", ccedil: "ç", agrave: "à", egrave: "è" };
const decode = (s) => s.replace(/&([a-zA-Z]+);/g, (m, e) => ENT[e] ?? " ")
  .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d));
// A pair cell is "Player One<br />Player Two<br />(españa-argentina)", so <br> is the only
// thing separating the two players — collapse it into a space and the boundary is gone for
// good (a dictionary can only re-split the ~28% of players famous enough to appear in a
// final). Keep it as a newline and every pair splits exactly.
// From 2018 the cells interleave each player with their hometown —
// "Alejandra Salazar<br><span class=legalgreybold>madrid, españa</span><br>Ariana Sánchez…" —
// so splitting on <br> alone yields four lines, not two players. The site marks that
// metadata with its own class, which is the reliable way to drop it; earlier seasons put
// the nationalities in plain parentheses instead, handled in pairPlayers.
const cellLines = (s) => decode(s
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<span[^>]*class="legalgrey[^"]*"[^>]*>[\s\S]*?<\/span>/gi, " ")
  .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
  .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
const stripTags = (s) => cellLines(s).join(" ").trim();

// Later seasons wrap the bracket in layout tables (2019 pages carry 25 of them where 2015
// had one), and a regex for <tr>/<td> cannot see nesting — it interleaves the wrapper's rows
// with the bracket's and the grid comes out scrambled. So find the bracket's own table first:
// walk every <table> with depth counting, and take the innermost one that still holds the
// round headers and a full complement of pair cells.
// Find each pair cell and, if it contains a nested table, replace that table with its rows
// as <br>-separated text. The cell's own end tag has to be located by depth-counting: a
// non-greedy /<\/td>/ would stop at the nested table's first cell instead.
function flattenNameCells(html) {
  const open = /<td[^>]*class="primera"[^>]*>/gi;
  const out = [];
  let last = 0, m;
  while ((m = open.exec(html))) {
    const start = m.index + m[0].length;
    const tag = /<\/?td[^>]*>/gi;
    tag.lastIndex = start;
    let depth = 1, end = -1, t;
    while ((t = tag.exec(html))) {
      depth += t[0].startsWith("</") ? -1 : 1;
      if (depth === 0) { end = t.index; break; }
    }
    if (end < 0) continue;
    const inner = html.slice(start, end);
    if (/<table/i.test(inner)) {
      const flat = inner.replace(/<\/tr>/gi, "<br />").replace(/<\/?(table|tbody|thead|tr|td|th)[^>]*>/gi, " ");
      out.push(html.slice(last, start), flat);
      last = end;
    }
    open.lastIndex = end;
  }
  out.push(html.slice(last));
  return out.join("");
}

function bracketTable(html) {
  // From 2021 each pair cell holds its OWN little table (a flag icon and a name per row).
  // That table has no "primera" class of its own, so the noise sweep below would delete the
  // players along with it. Flatten those in place first — one row per line, which is exactly
  // the shape the <br>-separated seasons already produce.
  html = flattenNameCells(html);

  // Later pages also sprinkle small nav/ad tables INSIDE the bracket. They carry no pair
  // cells, but their <tr>/<td> tags are indistinguishable to a regex and shift every row
  // that follows. Dissolve them innermost-first — what remains is a flat table again.
  let prev;
  do {
    prev = html;
    html = html.replace(/<table[^>]*>(?:(?!<table)[\s\S])*?<\/table>/gi,
      (m) => (/class="primera"/i.test(m) ? m : " "));
  } while (html !== prev);

  const tags = [...html.matchAll(/<\/?table[^>]*>/gi)];
  const spans = [];
  for (let i = 0; i < tags.length; i++) {
    if (tags[i][0].startsWith("</")) continue;
    let depth = 0;
    for (let j = i; j < tags.length; j++) {
      depth += tags[j][0].startsWith("</") ? -1 : 1;
      if (depth === 0) { spans.push(html.slice(tags[i].index, tags[j].index + tags[j][0].length)); break; }
    }
  }
  const ok = spans.filter((s) => {
    const heads = new Set();
    for (const m of s.matchAll(/<td[^>]*>([\s\S]{0,120}?)<\/td>/gi)) {
      const t = stripTags(m[1]);
      if (t && t.length < 24) { const r = roundOf(t); if (r) heads.add(r); }
    }
    return heads.size >= 3 && (s.match(/class="primera"/gi) || []).length >= 8;
  });
  // innermost qualifying table = the shortest one
  return ok.length ? ok.sort((a, b) => a.length - b.length)[0] : html;
}

// Build a true table grid: a rowspan blocks its columns on every later row, whether or not
// that row has enough cells to reach them, so occupancy is resolved per row rather than
// while walking cells (which silently drifts the columns and scrambles the bracket).
function buildGrid(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const grid = [];
  const pending = new Map();
  rows.forEach((rowHtml, r) => {
    grid[r] ||= [];
    const occupied = new Set([...pending].filter(([, n]) => n > 0).map(([col]) => col));
    let c = 0;
    for (const m of rowHtml.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)) {
      while (occupied.has(c) || grid[r][c]) c++;
      const attr = m[1];
      const colspan = +(attr.match(/colspan="(\d+)"/i)?.[1] || 1);
      const rowspan = +(attr.match(/rowspan="(\d+)"/i)?.[1] || 1);
      const lines = cellLines(m[2]);
      grid[r][c] = { text: lines.join(" ").trim(), lines, isName: /class="primera"/i.test(attr) };
      for (let k = 1; k < colspan; k++) grid[r][c + k] = { text: "", isName: false };
      if (rowspan > 1) for (let k = 0; k < colspan; k++) pending.set(c + k, rowspan - 1);
      c += colspan;
    }
    for (const col of occupied) {
      const n = pending.get(col) - 1;
      if (n > 0) pending.set(col, n); else pending.delete(col);
    }
  });
  return grid;
}

// --- domain parsing ---------------------------------------------------------
const ROUND_MAP = [
  [/^\s*(64|treintaidosavos|32avos)/i, "Round of 64"],
  [/^\s*(32|dieciseisavos|16avos|16\s*º|16º)/i, "Round of 32"],
  [/octavos|1\s*\/\s*8|8\s*º/i, "Round of 16"],
  [/cuartos|1\s*\/\s*4|4\s*º/i, "Quarterfinal"],
  [/semi/i, "Semifinal"],
  [/^\s*final/i, "Final"],
];
const roundOf = (label) => { for (const [re, name] of ROUND_MAP) if (re.test(label)) return name; return null; };

const WEEKDAY = /^(lun|mar|mie|mié|jue|vie|sab|sáb|dom)\b/i;
const SCORE_RE = /\b\d{1,2}\s*\/\s*\d{1,2}\b/;
// "7/6 6/3" is a score; "mie 25/3 10.30" is a kick-off time that also contains digits/slash.
const isScore = (t) => !!t && !WEEKDAY.test(t) && SCORE_RE.test(t) && !/^\d{1,2}[:.]\d{2}$/.test(t);

function normScore(raw) {
  const sets = [...raw.matchAll(/(\d{1,2})\s*\/\s*(\d{1,2})/g)].map((m) => `${m[1]}-${m[2]}`);
  if (!sets.length) return null;
  let s = sets.join(" ");
  if (/abandono|retir|lesi/i.test(raw)) s += " ab.";
  if (/w\.?o\.?|walkover|no se present/i.test(raw)) s += " wo";
  return s;
}

// Byes and qualifier placeholders occupy a name cell but are not players.
const PLACEHOLDER = /^(exento|exenta|bye|previa|preprevia|clasificad|qualifier|\-+)/i;
const cleanPair = (t) => t.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim();
// The cell's lines are [player one, player two, "(nationalities)"] — the parenthesised
// nationalities line is metadata, and a seeding marker can precede the names.
const pairPlayers = (lines = []) => lines
  .filter((l) => !/^\(/.test(l) && !/^\d+$/.test(l) && !PLACEHOLDER.test(l))
  .map((l) => l.replace(/^\s*\d+[.\-)]?\s*/, "").replace(/\s*\([^)]*\)/g, "").trim())
  .filter(Boolean);

export function parseDraw(html, meta = {}) {
  const grid = buildGrid(bracketTable(html));
  // header row: the row naming three or more rounds
  let hdr = -1, hdrCols = {};
  grid.forEach((row, r) => {
    if (hdr >= 0 || !row) return;
    const cols = {};
    row.forEach((cell, c) => { if (!cell?.text || cell.text.length > 24) return; const rn = roundOf(cell.text); if (rn) cols[c] = rn; });
    if (Object.keys(cols).length >= 3) { hdr = r; hdrCols = cols; }
  });
  if (hdr < 0) return [];

  // bucket names + scores by column
  const cols = {};
  grid.forEach((row, r) => (row || []).forEach((cell, c) => {
    if (!cell?.text) return;
    const b = (cols[c] ||= { names: [], scores: [] });
    if (cell.isName && !PLACEHOLDER.test(cell.text)) b.names.push({ r, t: cleanPair(cell.text), players: pairPlayers(cell.lines) });
    else if (isScore(cell.text)) b.scores.push({ r, t: cell.text });
  }));
  for (const b of Object.values(cols)) { b.names.sort((a, z) => a.r - z.r); b.scores.sort((a, z) => a.r - z.r); }

  const colIdx = Object.keys(hdrCols).map(Number).sort((a, z) => a - z);
  const out = [];
  const key = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");

  for (let i = 0; i < colIdx.length; i++) {
    const c = colIdx[i], next = colIdx[i + 1];
    const round = hdrCols[c];
    const here = cols[c]?.names || [];
    const advanced = new Set((next != null ? cols[next]?.names || [] : []).map((n) => key(n.t)));
    // participants pair up consecutively down the column; the one that reappears one
    // column right is the winner of that match
    for (let k = 0; k + 1 < here.length; k += 2) {
      const a = here[k], b = here[k + 1];
      if (key(a.t) === key(b.t)) continue;
      const aWon = advanced.has(key(a.t)), bWon = advanced.has(key(b.t));
      if (aWon === bWon) continue;                 // both or neither advanced: can't attribute
      const winner = aWon ? a : b, loser = aWon ? b : a;
      // the score sits beside the match, in this column or the next, within its row span
      const lo = Math.min(a.r, b.r) - 1, hi = Math.max(a.r, b.r) + 2;
      const cand = [...(cols[c]?.scores || []), ...(next != null ? cols[next]?.scores || [] : [])]
        .filter((s) => s.r >= lo && s.r <= hi)
        .sort((x, z) => Math.abs(x.r - loser.r) - Math.abs(z.r - loser.r));
      const score = cand.length ? normScore(cand[0].t) : null;
      if (!score) continue;                        // no clean score: drop rather than guess
      if (winner.players.length !== 2 || loser.players.length !== 2) continue; // unsplittable pair: drop
      out.push({ ...meta, round, winners: winner.players, losers: loser.players, score });
    }
  }
  return out;
}

// --- crawl ------------------------------------------------------------------
const hrefs = (html, re) => [...new Set([...html.matchAll(/href="([^"]+)"/gi)].map((m) => m[1]).filter((h) => re.test(h)))];

// importing this module (for tests) must not kick off a crawl
const RUN_DIRECTLY = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());

if (RUN_DIRECTLY) {
const all = [];
for (let year = Y0; year <= Y1; year++) {
  const idx = await get(`/wpt/${year}/`);
  if (!idx) { console.log(`${year}: index unavailable`); continue; }
  const tourns = hrefs(idx, new RegExp(`^/wpt/${year}/[a-z]+/[^/]+/$`, "i"));
  console.log(`\n${year}: ${tourns.length} tournaments`);
  for (const tp of tourns) {
    const page = await get(tp);
    const title = stripTags(page.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "");
    const name = title.replace(/\s*en Padelnetwork.*$/i, "").replace(/^WPT\s+World Padel Tour\s*/i, "").trim();
    const draws = hrefs(page, new RegExp(`^${tp}cuadro/(masculino|femenino)/(previa/|preprevia/)?$`, "i"));
    let n = 0;
    for (const dp of draws) {
      const gender = /femenino/i.test(dp) ? "Women" : "Men";
      const qual = /previa/i.test(dp);
      const html = await get(dp);
      if (!html) continue;
      const rows = parseDraw(html, { year, path: tp, name, gender, url: BASE + dp });
      // the previa/preprevia pages are qualifying draws whatever their internal round labels say
      for (const r of rows) if (qual) r.round = "Qualifying";
      all.push(...rows);
      n += rows.length;
    }
    console.log(`  ${String(n).padStart(3)} matches  ${name.slice(0, 58)}`);
  }
}

mkdirSync(join(ROOT, "scratch"), { recursive: true });
const OUT = join(ROOT, `scratch/pn-rounds-${Y0}${Y1 !== Y0 ? "-" + Y1 : ""}.json`);
writeFileSync(OUT, JSON.stringify(all, null, 2));
const byRound = {};
for (const m of all) byRound[m.round] = (byRound[m.round] || 0) + 1;
console.log(`\n${all.length} matches with scores -> ${OUT}`);
console.log(Object.entries(byRound).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  "));
}
