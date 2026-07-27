// Organiser lookup for RankedIn tournaments, with a disk-backed cache.
//
// RankedIn's UI labels a tournament's hosting club "Organisator", and that is the only
// real organiser data the API exposes: `TournamentSidebarModel.ClubName` + `ClubUrl`,
// gated by `HasConnectedClub`. NEITHER discovery feed carries it — the org feed
// (GetOrganisationEventsAsync) has a bare `club` name with no id or URL, and the global
// calendar feed has no club at all — so it costs one extra GetInfoAsync per tournament.
//
// That call is why this cache exists, and the cache is load-bearing, not an
// optimisation: refresh-loop.js re-runs every 60s while any match is live, over ~19
// tournaments, and the pipeline already spends one GetMatchesSectionAsync per tournament
// per cycle. Fetching the organiser uncached would double RankedIn API traffic for a
// value that never changes for a given event id.
//
// Persisted to a git-ignored .cache/ file so daemon restarts and one-shot
// scripts/fetch-live.js runs start warm. Misses are cached too (they are the majority —
// only ~1 in 3 tournaments has a connected club) but expire, so a club connected after
// we first looked is eventually picked up.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { rankedinGet } from "./http.js";

const FILE = join(process.cwd(), ".cache", "rankedin-clubs.json");
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // re-check "no club" weekly

/** @type {Map<string, {name:string,url:string}|{miss:number}>|null} */
let cache = null;

function load() {
  if (cache) return cache;
  cache = new Map();
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(FILE, "utf8")))) cache.set(k, v);
  } catch {
    // no cache yet (or corrupt) — start empty; it refills itself
  }
  return cache;
}

function persist() {
  try {
    mkdirSync(join(process.cwd(), ".cache"), { recursive: true });
    writeFileSync(FILE, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // a cache we can't write is still a cache we can use in-process
  }
}

/**
 * The organiser ("Organisator") behind a RankedIn tournament.
 * Never throws: a failed lookup returns null and is NOT cached, so the next cycle retries
 * rather than baking a transient network error in as "this event has no organiser".
 *
 * @param {number|string} eventId
 * @returns {Promise<{name:string,url:string}|null>}
 */
export async function fetchClub(eventId) {
  const key = String(eventId);
  const c = load();
  const hit = c.get(key);
  if (hit) {
    if (!hit.miss) return hit;
    if (Date.now() - hit.miss < MISS_TTL_MS) return null;
  }

  let sb;
  try {
    const info = await rankedinGet(`tournament/GetInfoAsync?id=${key}&language=en`);
    sb = info?.TournamentSidebarModel || {};
  } catch {
    return null; // deliberately uncached — see doc comment
  }

  const club = clubFrom(sb);
  c.set(key, club || { miss: Date.now() });
  persist();
  return club;
}

/**
 * Shared with scripts/backfill-archive-organizer.js so the live feed and the archive
 * backfill can never disagree about what counts as an organiser.
 *
 * @param {Object} sidebar TournamentSidebarModel from tournament/GetInfoAsync
 * @returns {{name:string,url:string}|null}
 */
export function clubFrom(sidebar) {
  const sb = sidebar || {};
  const name = (sb.ClubName || "").trim();
  const path = (sb.ClubUrl || "").trim();
  // All three must hold: an unconnected club leaves ClubName null and ClubUrl "", and a
  // name without a URL is exactly the partial organizer Google flagged in the first place.
  if (!sb.HasConnectedClub || !name || !path) return null;
  return { name, url: "https://www.rankedin.com" + path };
}
