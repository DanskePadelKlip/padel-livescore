// Node side of the per-event live files (src/live-tournaments.js): writes
// public/data/live-t/<key>.json for every event in the feed and deletes the files of
// events that have left it. Shared by scripts/refresh-loop.js and
// scripts/fetch-live.js: each deploy replaces the whole site, so a file only one
// producer wrote would vanish on the other one's deploy.
//
// No timestamp inside: a file's bytes change only when its event's rows do, so a
// deploy uploads the events that moved, not every file every cycle.
//
// Never throws: like the map feed, a failure here must not cost a cycle its
// matches.json deploy. An event without a file gets the generic shell.

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groupLiveTournaments } from "./live-tournaments.js";

// key -> the body last written. The daemon keeps it across cycles, so an unchanged
// event costs no disk read: reading ~100 files back took ~370 ms on the 3090.
const lastBody = new Map();

export function writeLiveTournaments(root, matches, { log = () => {} } = {}) {
  try {
    const dir = join(root, "public", "data", "live-t");
    mkdirSync(dir, { recursive: true });
    const { groups, skipped } = groupLiveTournaments(matches);
    let written = 0;
    for (const [key, rows] of groups) {
      const file = join(dir, key + ".json");
      const body = JSON.stringify({ count: rows.length, matches: rows });
      if (lastBody.get(key) === body && existsSync(file)) continue;
      writeFileSync(file, body);
      lastBody.set(key, body);
      written++;
    }
    let removed = 0;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".json") && !groups.has(f.slice(0, -5))) { unlinkSync(join(dir, f)); removed++; }
    }
    for (const key of lastBody.keys()) if (!groups.has(key)) lastBody.delete(key);
    if (skipped) log(`  live-t: ${skipped} row(s) with no usable event key`);
    return { events: groups.size, written, removed, skipped };
  } catch (e) {
    log(`  live-t files skipped: ${e.message}`);
    return null;
  }
}
