// One-time (resumable) backfill: add venue/address to archived tournament files so
// their Event structured data carries the required `location`. Google flagged
// padelticker.com for a missing SportsEvent `location` (GSC, 2026-07-24); the live
// feed now threads venue/address through, but the persistently-indexed pages are the
// static public/data/archive/t/<source>-<id>.json files, which predate that field.
//
// RankedIn ("rin-*") events expose full venue data via tournament/GetInfoAsync?id=.
// FIP ("fip-*") archives have no structured venue (city is only embedded in the name)
// and are intentionally skipped here — reported as a remaining gap, not silently.
//
// Resumable: files that already have `address` are skipped, so it's safe to re-run.
// Usage:  node scripts/backfill-archive-locations.js [--limit N] [--dry]

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rankedinGet, sleep } from "../src/http.js";

const DIR = join(process.cwd(), "public", "data", "archive", "t");
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LIMIT = (() => { const i = args.indexOf("--limit"); return i >= 0 ? Number(args[i + 1]) : Infinity; })();

const files = readdirSync(DIR).filter((f) => f.startsWith("rin-") && f.endsWith(".json"));
const fipCount = readdirSync(DIR).filter((f) => f.startsWith("fip-") && f.endsWith(".json")).length;

let filled = 0, skipped = 0, nodata = 0, failed = 0, processed = 0;

for (const file of files) {
  if (processed >= LIMIT) break;
  const path = join(DIR, file);
  let d;
  try { d = JSON.parse(readFileSync(path, "utf8")); } catch { failed++; continue; }

  if (d.address) { skipped++; continue; }        // already backfilled → resumable
  processed++;

  const id = file.slice("rin-".length, -".json".length);
  let info;
  try {
    info = await rankedinGet(`tournament/GetInfoAsync?id=${id}&language=en`);
  } catch (err) {
    failed++;
    console.log(`  ! ${file} — GetInfoAsync failed: ${err.message}`);
    await sleep(200);
    continue;
  }

  const sb = info?.TournamentSidebarModel || {};
  const address = (sb.Address || "").trim() || null;
  const venue = (sb.LocationName || sb.ClubName || "").trim() || null;

  if (!address && !venue) { nodata++; await sleep(150); continue; }

  if (address) d.address = address;
  if (venue) d.venue = venue;

  if (!DRY) writeFileSync(path, JSON.stringify(d));
  filled++;
  if (filled % 25 === 0) console.log(`  … ${filled} filled (${processed}/${files.length} rin processed)`);
  await sleep(150); // be polite to the API
}

console.log(`\n${DRY ? "[DRY RUN] " : ""}Backfill complete:`);
console.log(`  rin archives:      ${files.length}`);
console.log(`  filled:            ${filled}`);
console.log(`  already had addr:  ${skipped}`);
console.log(`  no venue data:     ${nodata}`);
console.log(`  failed:            ${failed}`);
console.log(`  fip archives left: ${fipCount}  (no structured venue — needs a separate padelfip.com scrape)`);
