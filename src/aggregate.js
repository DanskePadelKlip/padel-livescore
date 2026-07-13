// Aggregation layer — runs every registered adapter, merges their normalized
// output into one match list, and de-dupes by global id. This is what the edge
// function / build step will call; the UI reads its result.

import * as rankedin from "./adapters/rankedin.js";
import * as tournamentsoftware from "./adapters/tournamentsoftware.js";
import * as fip from "./adapters/fip.js";
import { closeBrowser } from "./browser.js";
import { assertMatch, STATUS } from "./schema.js";

// Register adapters here. RankedIn (JSON) covers DK/SE/DE/CZ; tournamentsoftware
// (browser-scraped) covers Norway; fip covers the FIP/Premier pro tour.
const ADAPTERS = [rankedin, tournamentsoftware, fip];

const STATUS_ORDER = { [STATUS.LIVE]: 0, [STATUS.UPCOMING]: 1, [STATUS.FINAL]: 2 };

// Returns { matches, sources } where sources = per-adapter status for health
// monitoring. Adapters are isolated: one throwing no longer kills the others.
export async function aggregate(opts = {}) {
  const byId = new Map();
  const sources = [];
  const log = opts.log || (() => {});
  try {
    for (const adapter of ADAPTERS) {
      try {
        const matches = await adapter.fetchMatches(opts);
        let n = 0;
        for (const m of matches) { assertMatch(m); byId.set(m.id, m); n++; } // last write wins on dupe id
        sources.push({ id: adapter.id || "?", ok: true, count: n });
      } catch (err) {
        sources.push({ id: adapter.id || "?", ok: false, count: 0, error: String(err?.message || err).slice(0, 200) });
        log(`  ! adapter ${adapter.id} failed — ${err?.message || err}`);
      }
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
