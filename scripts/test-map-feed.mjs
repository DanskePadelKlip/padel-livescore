// Unit tests for the /map feed: the level ladder, place queries, the two venue parsers,
// the feed builder against a fake geocoder, and team-league halls (no network).
import assert from "node:assert/strict";
import { levelOf, bandOf } from "../src/levels.js";
import { placeQueries, placeFromName, buildMapFeed, townsOfVenue, hallQueries } from "../src/map-feed.js";
import { parseVenue } from "../src/adapters/tournamentsoftware.js";
import { makeGeocoder } from "../src/geo.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventPlace } from "../src/adapters/fip.js";

let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ok  " + name); };

await ok("FIP slug beats the name", () => {
  assert.deepEqual(levelOf({ name: "Some Open", level: "fip-tour-gold" }), { rank: 50, label: "FIP Gold" });
  assert.equal(levelOf({ name: "MILANO P1", level: "fip-ppt-p1" }).label, "P1");
});
await ok("Premier Padel and FIP by name", () => {
  assert.equal(levelOf({ name: "MILANO P1" }).label, "P1");
  assert.equal(levelOf({ name: "FIP BRONZE OEIRAS" }).label, "FIP Bronze");
  assert.equal(levelOf({ name: "FIP World Cup Qualifiers – Europe" }).label, "FIP nations");
});
await ok("DPF levels come from class names, highest wins", () => {
  assert.equal(levelOf({ name: "Padelshoppen Open" }, ["Herrer DPF100", "Damer DPF200", "Damer DPF10"]).label, "DPF200");
  assert.equal(levelOf({ name: "X (DPF 100/60/35/25/10)" }).label, "DPF100");
  assert.equal(levelOf({ name: "Lunar Ligaen" }, ["Øst - 0. Elitedivision", "Vest - 1. Division - A"]).label, "Elitedivision");
});
await ok("Norway, Sweden, Britain", () => {
  assert.equal(levelOf({ name: "Tour (NPT 250/100/50)" }, ["NPT 250 Herrer"]).label, "NPT250");
  assert.equal(levelOf({ name: "Swedish Padel Tour-SPT Challenger 6" }).label, "SPT Challenger");
  assert.equal(levelOf({ name: "Padel Maidenhead - LTA Grade 3 (Men's & Women's)" }).label, "LTA G3");
  assert.equal(levelOf({ name: "Smash Padel Bicester O60's Tournament G5" }).label, "LTA G5");
});
await ok("SM/DM need real words (Smíchov is not a championship)", () => {
  assert.equal(levelOf({ name: "Business liga II - Padel Powers Smíchov", ranking: "Padel Powers ranking" }).label, "League");
  assert.equal(levelOf({ name: "Padel SM 2026" }).label, "National champs");
});
await ok("fallbacks and bands", () => {
  assert.equal(levelOf({ name: "Oktoberturnering", ranking: "No ranking" }).label, "Club");
  assert.equal(levelOf({ name: "Chișinău Open", ranking: "Clasamentul Moldova Padel Tour (1)" }).label, "Ranked");
  assert.equal(bandOf(20), "Premier Padel");
  assert.equal(bandOf(70), "FIP");
  assert.equal(bandOf(105), "National top level");
  assert.equal(bandOf(200), "Club and local");
});

await ok("place from event name", () => {
  assert.equal(placeFromName("FIP BRONZE OEIRAS", "fip"), "Oeiras");
  assert.equal(placeFromName("Padelocity Men's Grade 5 @ Pure Padel Nottingham", "tournamentsoftware"), "Pure Padel Nottingham");
  assert.equal(placeFromName("Norwegian Padel Tour by Powerade @Eidsvoll NPT500", "tournamentsoftware"), "Eidsvoll");
});
await ok("queries: local country word dropped, town fallback added", () => {
  const qs = placeQueries({ name: "Rosa Bandet open", address: "Lastvägen 8, 231 62 Trelleborg, Sverige" }, "rankedin", "SE").map((x) => x.q);
  assert.equal(qs[0], "Lastvägen 8, 231 62 Trelleborg, Sweden");
  assert.ok(qs.includes("Trelleborg, Sweden"));
  assert.equal(qs.at(-1), "Sweden");
});
await ok("queries: a bare street without a town is not used", () => {
  const qs = placeQueries({ name: "Padelverket Fall Open", address: "Silovägen 7a" }, "rankedin", "SE").map((x) => x.q);
  assert.ok(!qs.some((q) => q.includes("Silovägen")));
  assert.ok(placeQueries({ name: "X", address: "Silovägen 7a", city: "Haninge" }, "rankedin", "SE")[0].q.includes("Silovägen"));
});
await ok("queries: junk address skipped, FIP uses its country name", () => {
  assert.equal(placeQueries({ name: "Extraliga", address: "1" }, "rankedin", "CZ")[0].q, "Czechia");
  const fip = placeQueries({ name: "FIP GOLD X", address: "C/ ECONOMÍA 11-13", city: "Sevilla", countryName: "Spain" }, "fip", "FIP");
  assert.equal(fip[0].q, "C/ ECONOMÍA 11-13, Sevilla, Spain");
});

await ok("tournamentsoftware venue parse", () => {
  const html = '<div class="media__subheading">Padel Maidenhead Ltd | Berkshire</div>' +
    '<a href="https://www.google.com/maps/dir/?api=1&destination=MAIDENHEAD,Padel Pavilion,SL6 1BN,Great Britain">Route</a>';
  assert.deepEqual(parseVenue(html), { city: "Maidenhead", address: "Padel Pavilion, SL6 1BN", venue: "Padel Maidenhead Ltd" });
  const fed = '<div class="media__subheading">Norges Tennis- og Padelforbund | Oslo</div>';
  assert.deepEqual(parseVenue(fed), {});
});
await ok("FIP event page venue parse", () => {
  const html = '<span class="event__place">Sevilla  - Spain</span><div class="overview__venue"><p>Venue</p><p>ICÓNICO SPORTS &amp; SOCIAL</p><p>Address</p><p>C/ ECONOMÍA 11-13</p></div>';
  assert.deepEqual(eventPlace(html), { city: "Sevilla", countryName: "Spain", venue: "ICÓNICO SPORTS & SOCIAL", address: "C/ ECONOMÍA 11-13" });
  assert.deepEqual(eventPlace("<html></html>"), {});
});

await ok("feed: aggregates, places, rejects a namesake abroad", async () => {
  const answers = {
    "lincoln, united kingdom": { lat: 40.8, lng: -96.7, cc: "US", town: "Lincoln" },  // the wrong Lincoln
    "united kingdom": { lat: 54, lng: -2, cc: "GB", town: "", type: "country" },
    "odense, denmark": { lat: 55.4, lng: 10.4, cc: "DK", town: "Odense" },
  };
  const asked = [];
  const geocoder = {
    lookup: (q) => answers[q.toLowerCase()] ?? (asked.includes(q) ? null : undefined),
    resolve: async (qs) => { asked.push(...qs); return qs.length; },
    save: () => {},
  };
  const m = (id, src, fed, t, status, startTime, className) => ({ id, source: src, federation: fed, tournament: t, status, startTime, className, court: "C1" });
  const A = { id: 1, name: "LTA Grade 5 - Vida Del Padel Lincoln", city: "Lincoln" };
  const B = { id: 2, name: "Padelshoppen Open", address: "Odense" };
  const matches = [
    m("a1", "tournamentsoftware", "GB", A, "final", "2026-10-17T10:00:00"),
    m("b1", "rankedin", "DK", B, "live", "2026-10-17T11:00:00", "Herrer DPF200"),
    m("b2", "rankedin", "DK", B, "upcoming", "2026-10-18T09:00:00", "Damer DPF100"),
  ];
  const feed = await buildMapFeed(matches, { date: "2026-10-17", geocoder });
  assert.equal(feed.count, 2);
  const [dk, gb] = feed.events; // sorted by level: DPF200 (120) before LTA G5 (150)
  assert.equal(dk.level, "DPF200");
  assert.deepEqual([dk.total, dk.live, dk.upcoming, dk.tn, dk.tlive], [2, 1, 1, 1, 1]);
  assert.equal(dk.prec, "venue"); assert.equal(dk.cc, "DK");
  assert.equal(gb.prec, "country", "the US Lincoln must not be used for a GB event");
  assert.equal(gb.place, "Lincoln");
});

await ok("feed: a street hit far from the named town is skipped", async () => {
  const answers = {
    "padel pavilion, sl6 1bn, maidenhead, united kingdom": { lat: 51.515, lng: -0.092, cc: "GB", town: "City of London" },
    "padel pavilion, sl6 1bn, united kingdom": { lat: 51.515, lng: -0.092, cc: "GB", town: "City of London" },
    "maidenhead, united kingdom": { lat: 51.522, lng: -0.719, cc: "GB", town: "Maidenhead" },
  };
  const geocoder = { lookup: (q) => answers[q.toLowerCase()] ?? null, resolve: async () => 0, save: () => {} };
  const t = { id: 9, name: "Padel Maidenhead - LTA Grade 3", city: "Maidenhead", address: "Padel Pavilion, SL6 1BN", venue: "Padel Maidenhead Ltd" };
  const feed = await buildMapFeed([{ id: "x", source: "tournamentsoftware", federation: "GB", tournament: t, status: "final", startTime: "2026-10-17T09:00:00" }], { date: "2026-10-17", geocoder });
  assert.equal(feed.events[0].lng, -0.719, "must sit on Maidenhead, not the City of London");
  assert.equal(feed.events[0].prec, "town");
});

await ok("hall names: town words, generic tails skipped", () => {
  assert.deepEqual(townsOfVenue("Padel Lounge Aalborg"), ["Aalborg"]);
  assert.deepEqual(townsOfVenue("Rocket Padel Viborg - Fabrikvej"), ["Fabrikvej", "Viborg"]);
  assert.deepEqual(townsOfVenue("Rocket Padel Kolding - Sparekassen Kronjylland Padel Arena"), ["Kolding"]);
  assert.deepEqual(townsOfVenue("Padel City - Svendborg"), ["Svendborg"]);
  assert.deepEqual(townsOfVenue("Padelhuset Stæremosen 11, 3250 Gilleleje"), ["Gilleleje"]);
  assert.deepEqual(townsOfVenue("Padelton ApS"), []);
  assert.deepEqual(townsOfVenue("Pakhus 77"), []);
  assert.deepEqual(townsOfVenue("Match Padel Studio"), []);
  const qs = hallQueries("Padel Lounge Aalborg", "DK");
  assert.deepEqual(qs.map((x) => [x.q, x.prec]), [["Padel Lounge Aalborg, Denmark", "venue"], ["Aalborg, Denmark", "town"]]);
});

await ok("feed: a team league is drawn as one dot per hall with a tie today", async () => {
  const answers = {
    "denmark": { lat: 56, lng: 10, cc: "DK", town: "", type: "country" },
    "padel lounge aalborg, denmark": { lat: 57.03, lng: 9.93, cc: "DK", town: "Aalborg", type: "leisure" },
    "aalborg, denmark": { lat: 57.05, lng: 9.92, cc: "DK", town: "Aalborg", type: "city" },
    // a namesake: the Viborg branch's name finds the Aarhus one, 60 km off; the town is used
    "rocket padel viborg - fabrikvej, denmark": { lat: 56.15, lng: 10.2, cc: "DK", town: "Aarhus", type: "leisure" },
    "fabrikvej, denmark": { lat: 55.3, lng: 11.1, cc: "DK", town: "Slagelse", type: "road" },
    "viborg, denmark": { lat: 56.45, lng: 9.4, cc: "DK", town: "Viborg", type: "town" },
    "match padel studio, denmark": { lat: 55.66, lng: 12.5, cc: "DK", town: "Copenhagen", type: "leisure" },
    "padelton aps, denmark": { lat: 33, lng: -97, cc: "US", town: "Padelton", type: "leisure" }, // abroad: rejected
  };
  const geocoder = { lookup: (q) => answers[q.toLowerCase()] ?? null, resolve: async () => 0, save: () => {} };
  const L = { id: 7, name: "Lunar Ligaen 4P - Efterår 2026" };
  const tie = (id, court, a, b, status, startTime, sets) => ({
    id, source: "rankedin-teamleague", federation: "DK", tournament: L, className: "Øst - 1. Division", round: "Runde 3",
    court, status, startTime, teams: [{ name: a }, { name: b }], score: { sets }, raw: { tie: true },
  });
  const rubber = (id, court, startTime) => ({
    id, source: "rankedin-teamleague", federation: "DK", tournament: L, round: "A v B · Runde 3 · Kamp 1",
    court, status: "final", startTime, teams: [{ name: "x" }, { name: "y" }], raw: { tie: false },
  });
  const matches = [
    tie("t1", "Padel Lounge Aalborg", "Aalborg PK", "Hjørring", "live", "2026-10-18T13:00:00", [[2, 1]]),
    tie("t2", "Padel Lounge Aalborg", "Aalborg PK 2", "Skagen", "upcoming", "2026-10-18T10:00:00", []),
    rubber("r1", "Padel Lounge Aalborg", "2026-10-18T13:00:00"),
    rubber("r2", "Padel Lounge Aalborg", "2026-10-18T13:00:00"),
    tie("t3", "Rocket Padel Viborg - Fabrikvej", "Viborg", "Skive", "final", "2026-10-18T11:00:00", [[4, 2]]),
    tie("t4", "Match Padel Studio", "MPS", "KB", "final", "2026-10-18T09:00:00", [[3, 3]]),
    tie("t5", "Padelton ApS", "Padelton", "Horsens", "final", "2026-10-18T12:00:00", [[5, 1]]),
    tie("t6", "Vejle Padelcenter", "Vejle", "Fredericia", "upcoming", "2026-10-20T19:00:00", []), // not today
  ];
  const feed = await buildMapFeed(matches, { date: "2026-10-18", geocoder });
  assert.equal(feed.count, 1, "the league stays one event");
  const [e] = feed.events;
  assert.equal(e.prec, "country");
  assert.deepEqual(e.halls.map((h) => h.name), ["Padel Lounge Aalborg", "Rocket Padel Viborg - Fabrikvej", "Match Padel Studio", "Padelton ApS"]);
  const [aal, vib, mps, pdt] = e.halls;
  assert.deepEqual([aal.lat, aal.prec, aal.live, aal.ties.length], [57.03, "venue", 1, 2], "rubbers are not ties");
  assert.deepEqual(aal.ties.map((t) => [t.t, t.a, t.s, t.st]), [["10:00", "Aalborg PK 2", null, "upcoming"], ["13:00", "Aalborg PK", "2-1", "live"]]);
  assert.deepEqual([vib.lat, vib.prec], [56.45, "town"], "the Aarhus namesake and the road are skipped");
  assert.equal(vib.ties[0].s, "4-2");
  assert.deepEqual([mps.lat, mps.prec], [55.66, "venue"], "no town word: the venue hit stands");
  assert.deepEqual([pdt.lat, pdt.prec], [null, "none"], "a hit abroad leaves the hall unplaced, not on the country centre");
  // other sources carry no halls
  const other = await buildMapFeed([{ id: "z", source: "rankedin", federation: "DK", tournament: { id: 1, name: "X" }, status: "final", startTime: "2026-10-18T09:00:00", court: "C1" }], { date: "2026-10-18", geocoder });
  assert.equal(other.events[0].halls, undefined);
});

await ok("feed: hall towns are asked for even after the venue hit is cached", async () => {
  const answers = { "padel lounge aalborg, denmark": { lat: 57.03, lng: 9.93, cc: "DK", town: "Aalborg", type: "leisure" } };
  const asked = [];
  const geocoder = { lookup: (q) => answers[q.toLowerCase()] ?? (asked.includes(q) ? null : undefined), resolve: async (qs) => { asked.push(...qs); return qs.length; }, save: () => {} };
  const m = { id: "t", source: "rankedin-teamleague", federation: "DK", tournament: { id: 7, name: "Lunar" }, court: "Padel Lounge Aalborg",
    status: "upcoming", startTime: "2026-10-18T10:00:00", teams: [{ name: "A" }, { name: "B" }], score: { sets: [] }, raw: { tie: true } };
  await buildMapFeed([m], { date: "2026-10-18", geocoder });
  assert.ok(asked.includes("Aalborg, Denmark"));
  assert.ok(!asked.includes("Padel Lounge Aalborg, Denmark"), "a cached venue is not asked again");
});

await ok("geocoder: a seed hit beats a miss cached on this machine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "geo-"));
  const seedPath = join(dir, "seed.json"), cachePath = join(dir, "cache.json");
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(seedPath, JSON.stringify({ "match padel studio, denmark": { lat: 55.66, lng: 12.62, cc: "DK", town: "København", type: "venue-list" } }));
  writeFileSync(cachePath, JSON.stringify({ "match padel studio, denmark": { miss: today }, "nowhere, denmark": { miss: today }, "aalborg, denmark": { lat: 57, lng: 9.9, cc: "DK" } }));
  const g = makeGeocoder({ seedPath, cachePath });
  assert.equal(g.lookup("Match Padel Studio, Denmark").lat, 55.66);
  assert.equal(g.lookup("Nowhere, Denmark"), null);
  assert.equal(g.lookup("Aalborg, Denmark").lat, 57);
  rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${pass} passed`);
