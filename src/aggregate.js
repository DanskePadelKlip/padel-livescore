// Aggregation layer — runs every registered adapter, merges their normalized
// output into one match list, and de-dupes by global id. This is what the edge
// function / build step will call; the UI reads its result.

import * as rankedin from "./adapters/rankedin.js";
import * as tournamentsoftware from "./adapters/tournamentsoftware.js";
import * as fip from "./adapters/fip.js";
import { closeBrowser } from "./browser.js";
import { assertMatch, STATUS } from "./schema.js";

// Register adapters with a min refresh interval. RankedIn (JSON) is cheap and can
// carry live national scores every cycle; the browser-scraped sources are slow, so
// they refresh less often and their last result is reused in between — otherwise
// the multi-minute tournamentsoftware scrape would stall the ~1-min live loop.
// fip is the pro tour (has genuinely live matches) so it stays fairly fresh;
// tournamentsoftware is mostly completed results + schedules, so it can lag.
const ADAPTERS = [
  { mod: rankedin, minMs: 0 },                     // DK/SE/DE/CZ — every cycle
  { mod: fip, minMs: 2 * 60_000 },                 // FIP/Premier pro tour — ~2 min
  { mod: tournamentsoftware, minMs: 15 * 60_000 }, // NO/GB/AU — ~15 min
];

// Per-adapter cache (persists across cycles in the long-running daemon). Holds the
// last successful matches so a throttled-or-failed cycle still contributes them.
const cache = new Map(); // id -> { at, matches, ok, error }

const STATUS_ORDER = { [STATUS.LIVE]: 0, [STATUS.UPCOMING]: 1, [STATUS.FINAL]: 2 };

// Returns { matches, sources } where sources = per-adapter status for health
// monitoring. Adapters are isolated: one throwing no longer kills the others.
export async function aggregate(opts = {}) {
  const byId = new Map();
  const sources = [];
  const log = opts.log || (() => {});
  const force = opts.force === true; // ignore throttle (one-shot runs like fetch-live.js)
  try {
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
  } finally {
    // browser adapters (tournamentsoftware, fip) share one browser — close once.
    await closeBrowser();
  }
  // Sort: live first, then upcoming, then final; within a status, by start time.
  const matches = [...byId.values()].sort((a, b) => {
    const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (s !== 0) return s;
    return (a.startTime || "").localeCompare(b.startTime || "");
  });
  return { matches, sources };
}
