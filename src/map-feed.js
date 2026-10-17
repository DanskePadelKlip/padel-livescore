// /map feed: one row per tournament in the served match list, with its level and a
// place on the map. Written to public/data/map.json by both producers (refresh-loop.js
// and fetch-live.js) right after matches.json, so the page downloads ~30 KB instead of
// the multi-megabyte match list.
//
// Placing an event tries the most precise text first and keeps the first hit in the
// right country:
//   venue    the source's postal address, or venue name + town
//   town     the source's town, or a place read out of the event name
//   country  the country itself (drawn dashed on the map)
// The adapters supply venue/address/city (rankedin, fip, tournamentsoftware); team
// leagues and Puntuate events carry none and land on their country.

import { levelOf } from "./levels.js";

const regionNames = (() => {
  try { const d = new Intl.DisplayNames(["en"], { type: "region" }); return (c) => { try { return d.of(c); } catch { return null; } }; }
  catch { return () => null; }
})();

const isIso2 = (c) => /^[A-Z]{2}$/.test(c || "");

// "Padelocity Men's Grade 5 @ Pure Padel Nottingham" -> "Pure Padel Nottingham";
// "FIP BRONZE OEIRAS" -> "Oeiras". Only a fallback behind the adapters' own fields.
export function placeFromName(name, source) {
  let n = String(name || "").replace(/\(.*?\)/g, " ");
  if (source === "fip" || source === "puntuate") {
    n = n.replace(/\b(FIP|GOLD|SILVER|BRONZE|PLATINUM|P1|P2|MAJOR|PROMOTION|PROMISES|OPEN|CIUDAD DE|WORLD CUP|QUALIFIERS|EUROPE|IV|III|II)\b/gi, " ")
      .replace(/[–-]/g, " ").replace(/\s+/g, " ").trim();
    return n ? n.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : null;
  }
  for (const sep of ["@", " - ", " – ", " by "]) {
    if (!n.includes(sep)) continue;
    const tail = n.split(sep).pop()
      .replace(/\b(Grade|G)\s*\d.*|\b(Men|Women|Senior|O\d\d|\d\d\+).*/i, "")
      .replace(/\b(NPT|DPF|SPT)\s*\d+\b.*/i, "").trim();
    if (tail) return tail;
  }
  return null;
}

// Addresses often end in the country's own name ("..., Sverige"). Next to the English
// name we append, Nominatim then finds nothing, so a trailing country word is dropped.
const COUNTRY_WORDS = new Set([
  "sverige", "norge", "danmark", "deutschland", "česko", "česká republika", "magyarország", "românia",
  "great britain", "united kingdom", "españa", "italia", "polska", "suomi", "österreich", "schweiz", "suisse",
  "nederland", "ελλάδα", "ελλάς", "moçambique", "россия", "eesti", "hrvatska", "srbija", "slovensko",
  "slovenija", "lietuva", "latvija", "belgië", "belgique", "éire", "méxico", "bosna i hercegovina",
  "crna gora", "україна",
]);
const isCountryWord = (s, country) => {
  const w = s.toLowerCase().trim();
  return w === String(country || "").toLowerCase() || COUNTRY_WORDS.has(w);
};

/** Ordered geocoder queries for a tournament: [{ q, prec }]. */
export function placeQueries(t, source, fed) {
  const cc = isIso2(fed) ? fed : null;
  const country = t.countryName || (cc ? regionNames(cc) : null) || "";
  const withCountry = (s) => (country && !s.toLowerCase().includes(country.toLowerCase()) ? `${s}, ${country}` : s);
  const out = [];
  const city = String(t.city || "").trim();
  const parts = String(t.address || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1 && isCountryWord(parts.at(-1), country)) parts.pop();
  const address = parts.join(", ");
  // A bare street ("Silovägen 7a": a house number, no postcode, no town) exists in many
  // towns, and Nominatim picks one: that one came back 400 km from Haninge. Without a
  // town to check it against, it is not used at all.
  const bareStreet = parts.length === 1 && /\d/.test(address) && !/\d{3,}/.test(address) && !city;
  if (address && !/^\d{0,3}$/.test(address) && !bareStreet) {
    out.push({ q: withCountry(city && !address.toLowerCase().includes(city.toLowerCase()) ? `${address}, ${city}` : address), prec: "venue" });
    if (parts.length > 1) out.push({ q: withCountry(parts.slice(-2).join(", ")), prec: "town" });
    // "231 62 Trelleborg" -> "Trelleborg": the town on its own, postcode stripped
    const town = parts.at(-1).replace(/[\d-]+/g, " ").replace(/\s+/g, " ").trim();
    if (town.length > 2 && town !== address) out.push({ q: withCountry(town), prec: "town", anchor: 1 });
  }
  if (t.venue && city) out.push({ q: withCountry(`${t.venue}, ${city}`), prec: "venue" });
  if (city) out.push({ q: withCountry(city), prec: "town", anchor: 2 });
  const fromName = placeFromName(t.name, source);
  if (fromName) out.push({ q: withCountry(fromName), prec: "town" });
  if (country) out.push({ q: country, prec: "country" });
  return out;
}

function eventsOf(matches, date) {
  const byKey = new Map();
  for (const m of matches) {
    const t = m.tournament || {};
    const key = `${m.source}:${t.id}`;
    let e = byKey.get(key);
    if (!e) {
      e = { key, source: m.source, fed: m.federation, t, classes: new Set(), courts: new Set(),
        total: 0, final: 0, live: 0, upcoming: 0, tn: 0, tfinal: 0, tlive: 0 };
      byKey.set(key, e);
    }
    // RankedIn can see one event through two discovery paths: the calendar (a postal
    // address, sometimes only a street) and the federation feed (club and town). Merge
    // the copies field by field; for the address keep the fuller string.
    if (t !== e.t) {
      const merged = { ...e.t };
      for (const [f, v] of Object.entries(t)) {
        if (v == null || v === "") continue;
        if (merged[f] == null || merged[f] === "") merged[f] = v;
        else if (f === "address" && String(v).split(",").length > String(merged[f]).split(",").length) merged[f] = v;
      }
      e.t = merged;
    }
    e.total++;
    e[m.status] = (e[m.status] || 0) + 1;
    if (m.className) e.classes.add(String(m.className).replace(/\s+/g, " ").trim());
    if (m.court && m.source !== "rankedin-teamleague") e.courts.add(String(m.court));
    if (String(m.startTime || "").slice(0, 10) === date) {
      e.tn++;
      if (m.status === "final") e.tfinal++;
      if (m.status === "live") e.tlive++;
    }
  }
  return [...byKey.values()];
}

/**
 * @param {object[]} matches   the served match list
 * @param {{date:string, geocoder:ReturnType<import("./geo.js").makeGeocoder>, maxLookups?:number, budgetMs?:number, log?:Function}} opts
 */
export async function buildMapFeed(matches, { date, geocoder, maxLookups = 5, budgetMs = 8_000, log = () => {} }) {
  const events = eventsOf(matches, date);
  for (const e of events) e.queries = placeQueries(e.t, e.source, e.fed);

  // Ask only for what the cached answers cannot already place: walk each event's
  // queries until one is known to hit; everything before that, still unasked, queues.
  const want = [];
  // The town anchor is always asked for too: it is what a street-level hit is checked
  // against (see pick()).
  for (const e of events) {
    const anchor = anchorOf(e.queries);
    if (anchor && geocoder.lookup(anchor.q) === undefined) want.push(anchor.q);
    for (const { q } of e.queries) {
      const hit = geocoder.lookup(q);
      if (hit === undefined) { want.push(q); break; }
      if (hit && accept(hit, e.fed)) break;
    }
  }
  const asked = want.length ? await geocoder.resolve(want, { maxLookups, budgetMs }) : 0;
  if (asked) log(`  map: geocoded ${asked} new place(s), ${Math.max(0, new Set(want).size - asked)} queued`);
  geocoder.save();

  const rows = events.map((e) => {
    const place = pick(e, geocoder);
    const level = levelOf(e.t, [...e.classes]);
    return {
      k: e.key,
      src: e.source,
      fed: e.fed,
      name: String(e.t.name || "").replace(/\s+/g, " ").trim(),
      url: e.t.url || null,
      venue: e.t.venue || null,
      start: e.t.start || null,
      end: e.t.end || null,
      level: level.label,
      rank: level.rank,
      total: e.total, final: e.final, live: e.live, upcoming: e.upcoming,
      tn: e.tn, tfinal: e.tfinal, tlive: e.tlive,
      courts: e.courts.size,
      cc: place?.cc || (isIso2(e.fed) ? e.fed : null),
      lat: place?.lat ?? null,
      lng: place?.lng ?? null,
      // The source's own town reads better than OSM's (which can be a district or county)
      place: e.t.city || place?.town || null,
      prec: place?.prec || "none",
    };
  });
  rows.sort((a, b) => a.rank - b.rank || b.total - a.total);
  return { generatedAt: new Date().toISOString(), date, count: rows.length, events: rows };
}

const anchorOf = (queries) => queries.filter((x) => x.anchor).sort((a, b) => b.anchor - a.anchor)[0] || null;

// Street-level matching is loose: a postcode-and-street query for Maidenhead came back
// in the City of London, one for Lincoln near Wrexham. When the source names a town, any
// finer hit more than ANCHOR_KM from that town is a wrong match and is skipped.
const ANCHOR_KM = 25;
function km(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
function pick(e, geocoder) {
  const anchorQ = anchorOf(e.queries);
  const anchorHit = anchorQ ? geocoder.lookup(anchorQ.q) : null;
  const anchor = anchorHit && accept(anchorHit, e.fed) ? anchorHit : null;
  for (const { q, prec } of e.queries) {
    const hit = geocoder.lookup(q);
    if (!hit || !accept(hit, e.fed)) continue;
    if (anchor && prec !== "country" && q !== anchorQ.q && km(hit, anchor) > ANCHOR_KM) continue;
    return { ...hit, prec: hit.type === "country" ? "country" : prec };
  }
  return null;
}

// A hit in the wrong country is a namesake ("Fleet", "Lincoln"); FIP rows have no
// federation country to check against.
function accept(hit, fed) {
  if (!isIso2(fed) || !hit.cc) return true;
  return hit.cc === fed || (fed === "GB" && hit.cc === "UK");
}
