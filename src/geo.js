// Geocoding for /map: turns a tournament's place text into coordinates through
// OpenStreetMap Nominatim, behind two caches.
//
//   data/geocache.json   committed seed. Every producer (laptop daemon, GitHub Actions)
//                        starts from it, so known venues never cost a lookup.
//   .cache/geocache.json runtime additions on this machine (gitignored). Fold them into
//                        the seed now and then with scripts/seed-geocache.mjs.
//
// Nominatim's usage policy: at most 1 request/s, an identifying User-Agent, and cache
// results. Lookups are budgeted per call (a handful per cycle), so a burst of new events
// fills in over a few cycles instead of stretching one.
//
// A miss is cached as { miss: "<iso date>" } and retried after MISS_RETRY_DAYS, so a
// typo'd address does not cost a request every cycle forever.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const UA = "PadelTicker/1.0 (https://padelticker.com; danskepadelklip@gmail.com)";
const SPACING_MS = 1100;
const MISS_RETRY_DAYS = 7;

const readJson = (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}; } catch { return {}; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const geoKey = (q) => String(q || "").replace(/\s+/g, " ").trim().toLowerCase();

export function makeGeocoder({ seedPath, cachePath, fetchImpl = fetch, log = () => {} } = {}) {
  const seed = seedPath ? readJson(seedPath) : {};
  const runtime = cachePath ? readJson(cachePath) : {};
  let dirty = false;

  const fresh = (v) => v && (!v.miss || Date.now() - Date.parse(v.miss) < MISS_RETRY_DAYS * 864e5);

  /** @returns {object|null|undefined} a hit, null for a known miss, undefined if never asked */
  function lookup(q) {
    const k = geoKey(q);
    // A miss cached on this machine must not hide a place the seed has since learned
    const v = runtime[k] && !runtime[k].miss ? runtime[k] : seed[k] ?? runtime[k];
    if (!fresh(v)) return undefined;
    return v.miss ? null : v;
  }

  async function ask(q) {
    const url = `${ENDPOINT}?${new URLSearchParams({ q, format: "jsonv2", limit: "1", addressdetails: "1", "accept-language": "en" })}`;
    const res = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const h = (await res.json())[0];
    if (!h) return { miss: new Date().toISOString().slice(0, 10) };
    const a = h.address || {};
    return {
      lat: +(+h.lat).toFixed(5),
      lng: +(+h.lon).toFixed(5),
      cc: String(a.country_code || "").toUpperCase(),
      town: a.city || a.town || a.village || a.municipality || a.suburb || a.county || a.state || "",
      type: h.addresstype || h.type || "",
    };
  }

  /** Look up queries nobody has asked yet, within a budget. A failed request is not cached. */
  async function resolve(queries, { maxLookups = 5, budgetMs = 8_000 } = {}) {
    const t0 = Date.now();
    let n = 0;
    for (const q of [...new Set(queries.map((x) => String(x || "").trim()).filter(Boolean))]) {
      if (lookup(q) !== undefined) continue;
      if (n >= maxLookups || Date.now() - t0 > budgetMs) break;
      if (n) await sleep(SPACING_MS);
      n++;
      try {
        runtime[geoKey(q)] = await ask(q);
        dirty = true;
      } catch (e) {
        log(`  geocode "${q}" failed - ${e.message}`);
        break; // Nominatim is down or throttling us: stop for this cycle
      }
    }
    return n;
  }

  function save() {
    if (!dirty || !cachePath) return;
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(runtime, null, 1));
    dirty = false;
  }

  return { lookup, resolve, save, entries: () => ({ ...seed, ...runtime }) };
}
