// Capture Padel+ hall scoring — every tap of every Lunar rubber a hall scores on padelplus.app.
//
// WHY. Padel+ keeps only the current score per rubber (see src/padelplus.js). If nobody
// saves each version as it happens, the point-by-point history is gone. With it, a
// stream of that tie can get a burned-in board: the files here are the exact TSV
// scoreboard-tools/poll_live.py writes, so timeline_from_live.py reads them unchanged.
//
// ONE request per poll covers every hall: all rubbers touched in the last LOOKBACK_H.
//   live (a rubber in play, touched in the last LIVE_FRESH_MS)  every LIVE_MS
//   otherwise, daytime Copenhagen                               every IDLE_MS
//   QUIET_HOURS                                                 every QUIET_MS
// IDLE_MS bounds how many taps of a rubber's FIRST minute can be missed (a `# gap`).
//
// OUTPUT (OUT, default <repo>/capture/padelplus):
//   <day>/live_<tie>_p<position>.tsv   board rows, timestamps = the hall's tap (updated_at)
//   <day>/rows.jsonl                   every new version as Padel+ sent it (+ seen_at)
//   <day>/ties.json                    tie metadata from their overview (clubs, hall, division)
//   state.json                         last version kept per rubber, so a restart resumes
// <day> is the Copenhagen date of the tap.
//
//   node scripts/capture-padelplus.mjs            # run forever
//   node scripts/capture-padelplus.mjs --once     # one poll, print what it wrote
//   node scripts/capture-padelplus.mjs --once --since=2026-10-01   # backfill what is still there

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diffRows, fetchOverview, fetchRows } from "../src/padelplus.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.PADELPLUS_OUT || join(ROOT, "capture", "padelplus");
const argv = process.argv.slice(2);
const ONCE = argv.includes("--once");
const SINCE = (argv.find((a) => a.startsWith("--since=")) || "").slice(8) || null;

const LIVE_MS = 4_000;
const IDLE_MS = 20_000;
const QUIET_MS = 5 * 60_000;
const QUIET_HOURS = [1, 7];                 // [from, to) Copenhagen
const LIVE_FRESH_MS = 20 * 60_000;          // a "live" row untouched this long is abandoned (152684 kept two forever)
const LOOKBACK_H = 12;
const OVERVIEW_MS = 30 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const cphHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", hour: "2-digit", hour12: false }).format(new Date())) % 24;
const cphDay = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen" }).format(new Date(iso));

const STATE = join(OUT, "state.json");
mkdirSync(OUT, { recursive: true });
const last = new Map(existsSync(STATE) ? Object.entries(JSON.parse(readFileSync(STATE, "utf8")).versions || {}) : []);
function saveState() {
  const tmp = STATE + ".tmp";
  writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), versions: Object.fromEntries(last) }, null, 1));
  renameSync(tmp, STATE);
}

// Tie metadata, so a file named live_152605_p3.tsv can be told apart without RankedIn.
// The overview lists today onward only, so it is read while a tie is current.
const ties = new Map();                     // tie id -> overview row
let overviewAt = 0;
async function refreshOverview() {
  overviewAt = Date.now();
  try {
    const doc = await fetchOverview();
    for (const t of doc.lunar || []) ties.set(Number(t.id), { id: t.id, hjem: t.hjem, ude: t.ude, hal: t.hal, by: t.by, division: t.division, starts_at: t.starts_at });
  } catch (e) { log(`overview failed: ${e.message}`); }
}
function noteTie(day, tie) {
  const file = join(OUT, day, "ties.json");
  const doc = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (doc[tie] || !ties.has(tie)) return;
  doc[tie] = ties.get(tie);
  writeFileSync(file, JSON.stringify(doc, null, 1));
}

async function poll() {
  const since = SINCE ? new Date(SINCE).toISOString() : new Date(Date.now() - LOOKBACK_H * 3600_000).toISOString();
  const rows = await fetchRows(since);
  const seenAt = new Date().toISOString();
  const written = diffRows(last, rows);
  if (written.some((w) => !ties.has(Number(w.row.rankedin_match_id))) && Date.now() - overviewAt > 60_000) await refreshOverview();
  for (const { row, lines } of written) {
    const day = cphDay(row.updated_at);
    const dir = join(OUT, day);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `live_${row.rankedin_match_id}_p${row.position}.tsv`), lines.join("\n") + "\n", "utf8");
    appendFileSync(join(dir, "rows.jsonl"), JSON.stringify({ seen_at: seenAt, ...row }) + "\n", "utf8");
    noteTie(day, Number(row.rankedin_match_id));
  }
  if (written.length) saveState();
  const now = Date.now();
  const live = rows.filter((r) => r.phase === "live" && now - Date.parse(r.updated_at) < LIVE_FRESH_MS);
  return { rows: rows.length, written, live: live.length };
}

log(`capture-padelplus -> ${OUT}  (${last.size} rubbers already kept)${ONCE ? "  [once]" : ""}`);
await refreshOverview();
for (;;) {
  let live = 0;
  try {
    const r = await poll();
    live = r.live;
    if (r.written.length || ONCE) {
      const gaps = r.written.filter((w) => w.lines.some((l) => l.startsWith("# gap"))).length;
      log(`${r.rows} row(s) in window, ${live} live, ${r.written.length} new version(s)${gaps ? `, ${gaps} with a gap` : ""}` +
        (r.written.length ? ": " + [...new Set(r.written.map((w) => w.key))].join(" ") : ""));
    }
  } catch (e) { log(`poll failed: ${e.message}`); }
  if (ONCE) break;
  if (Date.now() - overviewAt > OVERVIEW_MS) await refreshOverview();
  const h = cphHour();
  await sleep(live ? LIVE_MS : h >= QUIET_HOURS[0] && h < QUIET_HOURS[1] ? QUIET_MS : IDLE_MS);
}
