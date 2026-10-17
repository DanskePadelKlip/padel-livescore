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
// leagues and Puntuate events carry none and land on their country. A team league's
// ties do name their hall, so its row also carries `halls`: one per hall with a tie
// today, each placed on its own (see hallsOf()).

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

// Team leagues (Lunar Ligaen) are one event spread over many halls: every tie is played
// at the home club, which the adapter writes into `court`. Today's ties are grouped by
// that hall so the map can draw one dot per hall instead of one on the country's centre.
const LEAGUE = "rankedin-teamleague";
// The tie row itself, not one of its rubbers (those repeat the venue and would count
// each tie six times). Rubber rounds end "· Kamp n".
const isTie = (m) => m.raw?.tie === true || (m.raw?.tie == null && !/·\s*Kamp \d+$/.test(m.round || ""));

// "Padel Lounge Aalborg" -> "Aalborg": a hall's name often ends in its town, which is
// both a fallback place and the anchor a venue hit is checked against. Each " - " or
// "," part of the name offers its last word ("Rocket Padel Viborg - Fabrikvej" offers
// Fabrikvej, then Viborg; pick() keeps the first that OSM calls a settlement). Generic
// tails ("Padel Club", "Arena", "ApS") are not towns.
const GENERIC = new Set(["padel", "club", "klub", "center", "centre", "centret", "padelcenter", "hal", "hallen", "halls", "arena",
  "indoor", "indendørs", "outdoor", "sport", "sports", "sportscenter", "idrætscenter", "tennis", "tennisklub", "court", "courts",
  "house", "hub", "park", "studio", "match", "rocket", "city", "world", "star", "lounge", "yard", "aps", "a/s", "ivs", "denmark", "danmark", "dk", "øst", "vest", "nord", "syd"]);
export function townsOfVenue(venue) {
  const parts = String(venue || "").replace(/\(.*?\)/g, " ").split(/\s[–-]\s|,/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  const town = (w) => w && w.length >= 3 && !/\d/.test(w) && !GENERIC.has(w.toLowerCase()) && /^\p{Lu}/u.test(w) && !out.includes(w);
  for (const p of [...parts].reverse()) {
    const words = p.split(/\s+/);
    if (words.length < 2 && parts.length < 2) continue; // a one-word name is the club, not a town
    if (town(words.at(-1))) out.push(words.at(-1));
  }
  // "Køge Padel Klub": with nothing at the end, the town may lead
  const first = parts[0]?.split(/\s+/);
  if (!out.length && first?.length > 2 && town(first[0])) out.push(first[0]);
  return out;
}

/** Geocoder queries for one hall of a team league: the venue itself, then its town(s). */
export function hallQueries(venue, fed) {
  const country = (isIso2(fed) ? regionNames(fed) : null) || "";
  const withCountry = (s) => (country ? `${s}, ${country}` : s);
  return [
    { q: withCountry(venue), prec: "venue" },
    ...townsOfVenue(venue).map((t) => ({ q: withCountry(t), prec: "town", anchor: 1 })),
  ];
}

function hallsOf(e, date) {
  const byName = new Map();
  for (const m of e.ties) {
    if (String(m.startTime || "").slice(0, 10) !== date) continue;
    const name = String(m.court || "").replace(/\s+/g, " ").trim();
    if (!name) continue;
    let h = byName.get(name);
    if (!h) byName.set(name, (h = { name, ties: [] }));
    const set = m.score?.sets?.[0];
    h.ties.push({
      a: m.teams?.[0]?.name || "",
      b: m.teams?.[1]?.name || "",
      s: Array.isArray(set) ? `${set[0]}-${set[1]}` : null,
      st: m.status,
      t: String(m.startTime || "").slice(11, 16) || null,
      cls: m.className || null,
    });
  }
  const halls = [...byName.values()];
  for (const h of halls) {
    h.ties.sort((x, y) => String(x.t).localeCompare(String(y.t)) || x.a.localeCompare(y.a));
    h.queries = hallQueries(h.name, e.fed);
  }
  return halls;
}

function eventsOf(matches, date) {
  const byKey = new Map();
  for (const m of matches) {
    const t = m.tournament || {};
    const key = `${m.source}:${t.id}`;
    let e = byKey.get(key);
    if (!e) {
      e = { key, source: m.source, fed: m.federation, t, classes: new Set(), courts: new Set(), ties: [],
        total: 0, final: 0, live: 0, upcoming: 0, tn: 0, tfinal: 0, tlive: 0 };
      byKey.set(key, e);
    }
    if (m.source === LEAGUE && isTie(m)) e.ties.push(m);
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
  for (const e of events) {
    e.queries = placeQueries(e.t, e.source, e.fed);
    e.halls = e.source === LEAGUE ? hallsOf(e, date) : [];
  }
  // Each hall is placed like an event of its own, in the league's country.
  const places = events.flatMap((e) => [e, ...e.halls.map((h) => ({ queries: h.queries, fed: e.fed, hall: h }))]);

  // Ask only for what the cached answers cannot already place: walk each event's
  // queries until one is known to hit; everything before that, still unasked, queues.
  const want = [];
  // The town anchor is always asked for too: it is what a street-level hit is checked
  // against (see pick()).
  for (const e of places) {
    // A hall may offer several town words; each is asked so pick() can choose.
    for (const a of e.hall ? e.queries.filter((x) => x.anchor) : [anchorOf(e.queries)].filter(Boolean)) {
      if (geocoder.lookup(a.q) === undefined) want.push(a.q);
    }
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
      ...(e.source === LEAGUE ? { halls: e.halls.map((h) => hallRow(h, geocoder, e.fed)) } : {}),
    };
  });
  rows.sort((a, b) => a.rank - b.rank || b.total - a.total);
  return { generatedAt: new Date().toISOString(), date, count: rows.length, events: rows };
}

// A hall that cannot be placed keeps lat/lng null: the page leaves it off the map rather
// than stack it on the country's centre, and still lists its ties under the league.
function hallRow(h, geocoder, fed) {
  const place = pick({ queries: h.queries, fed }, geocoder, { settlementAnchor: true });
  return {
    name: h.name,
    lat: place?.lat ?? null,
    lng: place?.lng ?? null,
    prec: place?.prec || "none",
    live: h.ties.filter((x) => x.st === "live").length,
    ties: h.ties,
  };
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
// A hall's anchor is a word read out of its name, so it only counts when OSM says it is
// a settlement: "Norden" or "Syd" may geocode to a farm or a road.
export const SETTLEMENT = new Set(["city", "town", "village", "hamlet", "suburb", "quarter", "neighbourhood", "municipality", "borough", "city_district", "administrative"]);
// A hall name that OSM answers with a street ("Pakhus 77" -> a road in Rudkøbing, the
// hall is in Aarhus) matched words, not the hall.
export const ROAD = new Set(["road", "street", "residential", "highway", "primary", "secondary", "tertiary", "unclassified", "service", "living_street", "pedestrian", "footway", "path", "track"]);
function pick(e, geocoder, { settlementAnchor = false } = {}) {
  const usable = (x) => { const h = geocoder.lookup(x.q); return h && accept(h, e.fed) && SETTLEMENT.has(h.type); };
  const anchorQ = settlementAnchor ? e.queries.find((x) => x.anchor && usable(x)) || null : anchorOf(e.queries);
  const anchorHit = anchorQ ? geocoder.lookup(anchorQ.q) : null;
  const anchor = anchorHit && accept(anchorHit, e.fed) ? anchorHit : null;
  for (const x of e.queries) {
    const { q, prec } = x;
    const hit = geocoder.lookup(q);
    if (!hit || !accept(hit, e.fed)) continue;
    if (settlementAnchor && x.anchor && !usable(x)) continue; // a road or farm, not a town
    if (settlementAnchor && prec === "venue" && ROAD.has(hit.type)) continue;
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
