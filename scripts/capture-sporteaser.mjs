// Capture the Sporteaser live feed for one or more tournaments.
//
// WHY: padelfip.com's livescore widget is an open JSON API that returns the FULL
// pointHistory of every match on every poll -- every game, every point value, who
// served, break points. But it carries NO wall-clock per point, only per-set
// durations. So OUR poll timestamps are the only time base there will ever be,
// and that is the part that cannot be recovered after the fact. Hence a capture
// rather than a one-off fetch.
//
// Only CHANGED responses are stored (sha1 of the body), gzipped, named by the UTC
// instant we saw them. That reconstructs the whole timeline with no duplicates.
//
//   node scripts/capture-sporteaser.mjs 397 [412 ...]
//
// Output goes OUTSIDE the repo (see OUT below): this repo's daemon deploys
// public/ every cycle, and capture data has no business on the website.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const OUT = process.env.SPORTEASER_OUT || "C:\\Users\\Dansk\\sporteaser-capture";
const TIDS = process.argv.slice(2).filter(Boolean);
if (!TIDS.length) TIDS.push("397");           // FIP Gold Belgrade 2026

const LIVE_MS = 25_000;        // a match is on -> poll tight, points move fast
const IDLE_MS = 5 * 60_000;    // nothing live -> back off, finished data is static
const OFF_MS = 30 * 60_000;    // today is not a tournament day -> barely look
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = new Map();        // tid -> sha1 of the last body we stored

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

async function poll(tid) {
  const day = new Date().getUTCDate();
  const url = `https://v0.sporteaser.app/api/public/tournament/${tid}/matches/day/${day}/sort/fieldname/0`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (body.length < 100) throw new Error("suspiciously short body");

  const hash = createHash("sha1").update(body).digest("hex");
  let stored = false;
  if (last.get(tid) !== hash) {
    mkdirSync(join(OUT, String(tid)), { recursive: true });
    writeFileSync(join(OUT, String(tid), `${stamp()}.json.gz`), gzipSync(body));
    last.set(tid, hash);
    stored = true;
  }

  // Shape the cadence to what is actually happening. matchStatus: 1 scheduled,
  // 2 live, 4 finished. `days` lists the tournament's real days, so once today
  // is not one of them there is nothing to watch.
  let live = 0, onDay = true;
  try {
    const j = JSON.parse(body);
    const arr = Array.isArray(j) ? j : (j.matches || j.data || []);
    live = arr.filter((m) => m.matchStatus === 2).length;
    if (Array.isArray(j.days) && j.days.length) onDay = j.days.includes(day);
  } catch { /* unparseable -> treat as idle, we still stored the bytes */ }
  return { live, onDay, stored, bytes: body.length };
}

console.log(`capture-sporteaser starting -> ${OUT}  tournaments: ${TIDS.join(", ")}`);
for (;;) {
  let live = 0, onDay = false;
  for (const tid of TIDS) {
    try {
      const r = await poll(tid);
      live += r.live; onDay = onDay || r.onDay;
      if (r.stored) console.log(`[${new Date().toISOString()}] ${tid}: stored ${r.bytes}b, ${r.live} live`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] ${tid}: ${e.message}`);
    }
  }
  await sleep(!onDay ? OFF_MS : live ? LIVE_MS : IDLE_MS);
}