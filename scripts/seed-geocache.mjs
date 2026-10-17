// Fold geocoder answers into the committed seed (data/geocache.json) so every producer,
// GitHub Actions included, starts with them.
//
//   node scripts/seed-geocache.mjs            # geocode everything in public/data/matches.json
//                                             # (no budget, ~1 s per new place), then fold
//   node scripts/seed-geocache.mjs --fold     # only fold .cache/geocache.json into the seed
//
// Commit data/geocache.json afterwards. Misses are not folded: they expire and get
// retried, and a seed full of misses would pin them for every producer.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeGeocoder } from "../src/geo.js";
import { buildMapFeed } from "../src/map-feed.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seedPath = join(root, "data", "geocache.json");
const cachePath = join(root, ".cache", "geocache.json");

if (!process.argv.includes("--fold")) {
  const { matches, date } = JSON.parse(readFileSync(join(root, "public", "data", "matches.json"), "utf8"));
  const geocoder = makeGeocoder({ seedPath, cachePath, log: console.log });
  // Several passes: each pass asks for the next untried query of every event that is
  // still unplaced, so an address miss falls through to its town on the next pass.
  for (let pass = 1; pass <= 6; pass++) {
    const before = Object.keys(geocoder.entries()).length;
    const feed = await buildMapFeed(matches, { date, geocoder, maxLookups: 500, budgetMs: 15 * 60_000, log: console.log });
    const placed = feed.events.filter((e) => e.lat != null).length;
    console.log(`pass ${pass}: ${placed}/${feed.count} placed`);
    if (Object.keys(geocoder.entries()).length === before) break;
  }
}

const seed = existsSync(seedPath) ? JSON.parse(readFileSync(seedPath, "utf8")) : {};
const runtime = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
let added = 0;
for (const [k, v] of Object.entries(runtime)) if (v && !v.miss && !seed[k]) { seed[k] = v; added++; }
const sorted = Object.fromEntries(Object.entries(seed).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(seedPath, JSON.stringify(sorted, null, 1) + "\n");
console.log(`seed: +${added}, ${Object.keys(sorted).length} places in data/geocache.json`);
