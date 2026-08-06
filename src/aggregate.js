// Aggregation layer — runs every registered adapter, merges their normalized
// output into one match list, and de-dupes by global id. This is what the edge
// function / build step will call; the UI reads its result.

import * as rankedin from "./adapters/rankedin.js";
import * as tournamentsoftware from "./adapters/tournamentsoftware.js";
import * as fip from "./adapters/fip.js";
import { assertMatch, STATUS } from "./schema.js";

// Register adapters with a min refresh interval. All three are now plain fetch +
// linkedom (no browser). RankedIn (a single JSON call) is cheapest and refreshes
// every cycle to carry live national scores; fip is the pro tour (genuinely live
// matches) so it stays fairly fresh; tournamentsoftware is many small fetches and
// mostly completed results + schedules, so it refreshes less often and its last
// result is reused in between.
const ADAPTERS = [
  { mod: rankedin, minMs: 0 },                     // DK/SE/DE/CZ — every cycle
  { mod: fip, minMs: 2 * 60_000 },                 // FIP/Premier pro tour — ~2 min
  { mod: tournamentsoftware, minMs: 15 * 60_000 }, // NO/GB/AU — ~15 min
];

// Per-adapter cache (persists across cycles in the long-running daemon). Holds the
// last successful matches so a throttled-or-failed cycle still contributes them.
const cache = new Map(); // id -> { at, matches, ok, error }

const STATUS_ORDER = { [STATUS.LIVE]: 0, [STATUS.UPCOMING]: 1, [STATUS.FINAL]: 2 };

// Merge per-adapter match lists (in adapter order — last write wins on dupe id)
// into the one sorted list the site serves. Shared with worker/index.js, which
// refreshes one source at a time and re-merges from persisted per-source blobs;
// keep the sort/dedupe HERE so the two pipelines can't disagree.
export function mergeMatches(lists) {
  const byId = new Map();
  for (const arr of lists) for (const m of arr || []) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => {
    const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (s !== 0) return s;
    return (a.startTime || "").localeCompare(b.startTime || "");
  });
}

// Returns { matches, sources } where sources = per-adapter status for health
// monitoring. Adapters are isolated: one throwing no longer kills the others.
export async function aggregate(opts = {}) {
  const byId = new Map();
  const sources = [];
  const log = opts.log || (() => {});
  const force = opts.force === true; // ignore throttle (one-shot runs like fetch-live.js)
  // All adapters are now plain fetch + linkedom (no shared browser to tear down).
  for (const { mod, minMs } of ADAPTERS) {
    const id = mod.id || "?";
    const prev = cache.get(id);
    const due = force || !prev || Date.now() - prev.at >= minMs;
    if (due) {
      try {
        const matches = await mod.fetchMatches(opts);
        for (const m of matches) assertMatch(m); // validate before caching
        cache.set(id, { at: Date.now(), matches, ok: true, error: null });
      } catch (err) {
        // Keep last-good matches (if any) so a transient scrape failure doesn't
        // wipe the source from the site; mark it failed for health. `at` advances
        // so a slow source retries on its normal interval, not every cycle.
        cache.set(id, { at: Date.now(), matches: prev?.matches || [], ok: false, error: String(err?.message || err).slice(0, 200) });
        log(`  ! adapter ${id} failed — ${err?.message || err}`);
      }
    }
    const c = cache.get(id);
    let n = 0;
    for (const m of c.matches) { byId.set(m.id, m); n++; } // last write wins on dupe id
    sources.push({ id, ok: c.ok, count: n, ...(c.ok ? {} : { error: c.error }) });
  }
  // Sort: live first, then upcoming, then final; within a status, by start time.
  const matches = [...byId.values()].sort((a, b) => {
    const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (s !== 0) return s;
    return (a.startTime || "").localeCompare(b.startTime || "");
  });
  return { matches, sources };
}
