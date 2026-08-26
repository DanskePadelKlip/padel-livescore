// One-time (resumable) backfill: add organizer/organizerUrl to archived tournament files
// so their Event structured data carries a real `organizer`. Google flagged
// padelticker.com for a missing `url` inside `organizer` (GSC, 2026-07-27) — but the
// deeper fault was the VALUE: with no organiser on file, the page fell back to publishing
// the federation code ("SE") as an Organization name, and the live feed published
// RankedIn's `OrganisationName` ("Liga", "No ranking"), which is a ranking label.
//
// The live feed now looks the organiser up per tournament (src/rankedin-club.js), but the
// persistently-indexed pages are the static public/data/archive/t/<source>-<id>.json
// files. Nothing in this repo regenerates them, so this script is their only fix path and
// its output must be committed.
//
// RankedIn ("rin-*") events expose the organiser their UI labels "Organisator" via
// tournament/GetInfoAsync?id= — ClubName + ClubUrl, gated on HasConnectedClub. Roughly one
// in three archived tournaments has one; the rest correctly end up with no `organizer` at
// all rather than a fabricated one. FIP ("fip-*") archives have no RankedIn record and are
// skipped — reported as a remaining gap, not silently dropped.
//
// Resumable: files that already carry `organizerUrl`, or a `noOrganizer` marker from a
// previous run, are skipped — so a re-run costs nothing for the majority that have none.
// Usage:  node scripts/backfill-archive-organizer.js [--limit N] [--dry]
//
// SOURCE OF TRUTH IS padel.db, NOT THIS SCRIPT. `padel-db/export_archive.py` rebuilds
// every archive file from the database and will overwrite whatever this writes. The
// durable path is padel-db: `rin_tournaments.organizer`/`organizer_url`, populated by
// `load_rankedin.py --fill-info`, emitted by `export_archive.py`. This script remains
// only as a direct patcher for when running the full export isn't wanted — if its output
// and the DB ever disagree, the DB wins on the next export.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rankedinGet, sleep } from "../src/http.js";
import { clubFrom } from "../src/rankedin-club.js";

const DIR = join(process.cwd(), "public", "data", "archive", "t");
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LIMIT = (() => { const i = args.indexOf("--limit"); return i >= 0 ? Number(args[i + 1]) : Infinity; })();

const files = readdirSync(DIR).filter((f) => f.startsWith("rin-") && f.endsWith(".json"));
const fipCount = readdirSync(DIR).filter((f) => f.startsWith("fip-") && f.endsWith(".json")).length;

let filled = 0, skipped = 0, noclub = 0, failed = 0, processed = 0;

for (const file of files) {
  if (processed >= LIMIT) break;
  const path = join(DIR, file);
  let d;
  try { d = JSON.parse(readFileSync(path, "utf8")); } catch { failed++; continue; }

  if (d.organizerUrl || d.noOrganizer) { skipped++; continue; }   // already settled → resumable
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

  // Same gate as the live feed, so the two can never disagree about what an organiser is.
  const club = clubFrom(info?.TournamentSidebarModel);

  if (!club) {
    // Record the miss so a re-run doesn't refetch the ~2/3 that have no connected club.
    d.noOrganizer = true;
    if (!DRY) writeFileSync(path, JSON.stringify(d));
    noclub++;
    await sleep(150);
    continue;
  }

  d.organizer = club.name;
  d.organizerUrl = club.url;

  if (!DRY) writeFileSync(path, JSON.stringify(d));
  filled++;
  if (filled % 25 === 0) console.log(`  … ${filled} filled (${processed}/${files.length} rin processed)`);
  await sleep(150); // be polite to the API
}

console.log(`\n${DRY ? "[DRY RUN] " : ""}Organiser backfill complete:`);
console.log(`  rin archives:       ${files.length}`);
console.log(`  filled:             ${filled}`);
console.log(`  already settled:    ${skipped}`);
console.log(`  no connected club:  ${noclub}  (correctly get no organizer)`);
console.log(`  failed:             ${failed}`);
console.log(`  fip archives left:  ${fipCount}  (no RankedIn record — no organiser source)`);
