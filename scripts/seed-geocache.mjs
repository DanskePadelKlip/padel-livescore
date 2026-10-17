// Fold geocoder answers into the committed seed (data/geocache.json) so every producer,
// GitHub Actions included, starts with them.
//
//   node scripts/seed-geocache.mjs            # geocode everything in public/data/matches.json
//                                             # (no budget, ~1 s per new place), then fold
//   node scripts/seed-geocache.mjs --fold     # only fold .cache/geocache.json into the seed
//   ... --venues <dk_venues.csv>              # also place team-league halls Nominatim cannot
//                                             # find from a geocoded venue list (name,street,
//                                             # zip,town,lat,lng,...), checked against the town
//
// Commit data/geocache.json afterwards. Misses are not folded: they expire and get
// retried, and a seed full of misses would pin them for every producer.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeGeocoder, geoKey } from "../src/geo.js";
import { buildMapFeed, hallQueries, SETTLEMENT, ROAD } from "../src/map-feed.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seedPath = join(root, "data", "geocache.json");
const cachePath = join(root, ".cache", "geocache.json");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const readMatches = () => JSON.parse(readFileSync(join(root, "public", "data", "matches.json"), "utf8"));

if (!process.argv.includes("--fold")) {
  const { matches, date } = readMatches();
  const geocoder = makeGeocoder({ seedPath, cachePath, log: console.log });
  // League halls are only placed for the day asked, so every day with a tie in the
  // feed's window is walked too: tomorrow's halls are then known before tomorrow.
  const days = [...new Set([date, ...matches.filter((m) => m.source === "rankedin-teamleague").map((m) => String(m.startTime || "").slice(0, 10)).filter(Boolean)])].sort();
  // Several passes: each pass asks for the next untried query of every event that is
  // still unplaced, so an address miss falls through to its town on the next pass.
  for (let pass = 1; pass <= 6; pass++) {
    const before = Object.keys(geocoder.entries()).length;
    for (const d of days) {
      const feed = await buildMapFeed(matches, { date: d, geocoder, maxLookups: 500, budgetMs: 15 * 60_000, log: console.log });
      if (d !== date) continue;
      const placed = feed.events.filter((e) => e.lat != null).length;
      const halls = feed.events.flatMap((e) => e.halls || []);
      console.log(`pass ${pass}: ${placed}/${feed.count} placed, halls today ${halls.filter((h) => h.lat != null).length}/${halls.length}`);
    }
    if (Object.keys(geocoder.entries()).length === before) break;
  }
}

const seed = existsSync(seedPath) ? JSON.parse(readFileSync(seedPath, "utf8")) : {};
const runtime = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
let added = 0;
for (const [k, v] of Object.entries(runtime)) if (v && !v.miss && !seed[k]) { seed[k] = v; added++; }

let runtimeDirty = false;
const venuesCsv = arg("--venues");
if (venuesCsv) added += seedHalls(venuesCsv);
if (runtimeDirty) writeFileSync(cachePath, JSON.stringify(runtime, null, 1));

const sorted = Object.fromEntries(Object.entries(seed).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(seedPath, JSON.stringify(sorted, null, 1) + "\n");
console.log(`seed: +${added}, ${Object.keys(sorted).length} places in data/geocache.json`);

// A hall's venue query ("Match Padel Studio, Denmark") gets the list's coordinates when
// Nominatim has none, but only when the list row sits within 25 km of a town read out
// of the hall's name: the list has rows with the wrong town's address.
function seedHalls(csvPath) {
  const norm = (s) => String(s || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/^.*\|/, " ")
    .replace(/\b(aps|ivs|a\/s)\b/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const byName = new Map();
  for (const r of parseCsv(readFileSync(csvPath, "utf8").replace(String.fromCharCode(0xfeff), ""))) {
    const lat = +r.lat, lng = +r.lng;
    if (!r.name || !Number.isFinite(lat) || !Number.isFinite(lng) || !lat) continue;
    for (const k of new Set([r.name.toLowerCase().trim(), norm(r.name)])) if (!byName.has(k)) byName.set(k, { ...r, lat, lng });
  }
  const km = (a, b) => {
    const p = Math.PI / 180, h = Math.sin(((b.lat - a.lat) * p) / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(((b.lng - a.lng) * p) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  };
  const known = (q) => { const v = seed[geoKey(q)]; return v && !v.miss ? v : null; };
  const halls = new Map();
  for (const m of readMatches().matches) if (m.source === "rankedin-teamleague" && m.court) halls.set(String(m.court).replace(/\s+/g, " ").trim(), m.federation);
  let n = 0;
  for (const [venue, fed] of halls) {
    const [vq, ...towns] = hallQueries(venue, fed);
    // "Rocket Padel Kolding - Sparekassen Kronjylland Padel Arena" is listed by its first part
    const head = venue.split(/\s[–-]\s/)[0];
    const row = byName.get(venue.toLowerCase()) || byName.get(norm(venue)) || (head !== venue && head.split(/\s+/).length > 1 ? byName.get(norm(head)) : null);
    const anchor = towns.map((t) => known(t.q)).find((h) => h && SETTLEMENT.has(h.type));
    // OSM's answer counts only where pick() would use it: a road is a word match
    const osm = known(vq.q), have = osm && !ROAD.has(osm.type) ? osm : null;
    if (!row) { if (!have) console.log(`  hall not in the list and not on OSM: ${venue}${anchor ? ` (placed on ${anchor.town})` : ""}`); continue; }
    if (have) {
      if (km(row, have) > 25) console.log(`  ! ${venue}: OSM and the list are ${Math.round(km(row, have))} km apart; OSM kept`);
      continue;
    }
    if (anchor && km(row, anchor) > 25) { console.log(`  ! ${venue}: the list puts it ${Math.round(km(row, anchor))} km from ${anchor.town}; skipped`); continue; }
    const k = geoKey(vq.q);
    seed[k] = { lat: +row.lat.toFixed(5), lng: +row.lng.toFixed(5), cc: fed === "DK" ? "DK" : String(fed || ""), town: row.town || "", type: "venue-list" };
    if (runtime[k]) { delete runtime[k]; runtimeDirty = true; } // this machine's road answer would shadow it
    n++;
  }
  console.log(`  halls from ${csvPath.split(/[\\/]/).pop()}: +${n} of ${halls.size} seen in the feed`);
  return n;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}
