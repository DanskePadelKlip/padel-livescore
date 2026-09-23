// Loading and storing the puntuate archive on a box with a filesystem.
//
// Split from puntuate-archive.js because that module is imported by a Pages
// Function, where node:fs does not exist. The merge rules live there; only the
// reading and writing live here, and both producers (scripts/refresh-loop.js on
// the laptop, scripts/fetch-live.js in CI) go through these two functions so
// they cannot drift apart.
//
// Two failures this exists to prevent:
//
//   * A fresh checkout has no archive file, and writing a new one from today's
//     rows alone would publish it over the deployed copy - deleting every result
//     the site had kept. So a missing file is SEEDED from what is published.
//   * A half-written file is not a reason to start again: the daemon deploys
//     public/ wholesale every cycle, so replacing an unreadable archive with
//     today's rows would make the loss permanent within a minute. An unreadable
//     file is left exactly as it is, and that cycle simply does not archive.
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export const DEPLOYED_ARCHIVE_URL = "https://padelticker.com/data/puntuate-archive.json";

// Anything we adopt from the network has to look like an archive: Pages serves
// an HTML fallback for a missing path, and JSON.parse is not the whole check.
function looksLikeArchive(j) {
  return !!j && typeof j === "object" && j.matches && typeof j.matches === "object" && !Array.isArray(j.matches);
}

// -> { archive, writable }. `writable: false` means "leave the file alone".
export async function loadArchive(path, { url = DEPLOYED_ARCHIVE_URL, log = () => {} } = {}) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (looksLikeArchive(j)) return { archive: j, writable: true };
    log("archive has an unexpected shape - not archiving this cycle");
    return { archive: null, writable: false };
  } catch (e) {
    if (e.code !== "ENOENT") {
      log(`archive unreadable (${e.message}) - not archiving this cycle`);
      return { archive: null, writable: false };
    }
  }
  try {
    const r = await fetch(`${url}?_=${Date.now()}`);
    if (r.ok) {
      const j = await r.json();
      if (looksLikeArchive(j)) {
        log(`archive seeded from the deployed copy (${Object.keys(j.matches).length} rows)`);
        return { archive: j, writable: true };
      }
    }
  } catch (e) {
    log(`archive seed failed (${e.message}) - starting empty`);
  }
  return { archive: null, writable: true };
}

// Written beside the target and renamed into place, so a deploy - which runs
// every cycle, concurrently with the next one - can never upload a file caught
// halfway through being written.
export function saveArchive(path, archive) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(archive));
  renameSync(tmp, path);
}
