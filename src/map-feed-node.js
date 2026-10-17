// Node side of the /map feed: wires the geocoder caches to disk and writes
// public/data/map.json. Shared by scripts/refresh-loop.js and scripts/fetch-live.js so
// the two producers cannot drift.
//
// Never throws: the map is a side dish, and a failure here must not cost a cycle its
// matches.json deploy. The last good map.json simply stays in place.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeGeocoder } from "./geo.js";
import { buildMapFeed } from "./map-feed.js";

let geocoder = null; // the daemon keeps one across cycles

export async function writeMapFeed(root, matches, date, { log = () => {}, maxLookups, budgetMs } = {}) {
  try {
    geocoder ??= makeGeocoder({
      seedPath: join(root, "data", "geocache.json"),
      cachePath: join(root, ".cache", "geocache.json"),
      log,
    });
    const feed = await buildMapFeed(matches, { date, geocoder, log, maxLookups, budgetMs });
    writeFileSync(join(root, "public", "data", "map.json"), JSON.stringify(feed));
    const placed = feed.events.filter((e) => e.lat != null).length;
    return { events: feed.count, placed };
  } catch (e) {
    log(`  map feed skipped: ${e.message}`);
    return null;
  }
}
