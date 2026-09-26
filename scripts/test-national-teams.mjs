#!/usr/bin/env node
// Headless smoke test for the National teams section. There is no browser on the
// build box, so app.js is run inside a linkedom DOM with the handful of browser
// globals it touches stubbed out, and the assertions are on state + the rendered
// HTML rather than on pixels.
//
//   node scripts/test-national-teams.mjs
//
// It needs `linkedom`, which lives in the main checkout's node_modules — pass
// NODE_PATH or run from a tree that has it:
//   NODE_PATH="../padel-livescore/node_modules" node scripts/test-national-teams.mjs
//
// What it cannot see: layout, CSS, and whether a click LOOKS right. Those stay on
// the manual list in docs/national-teams-progress.md.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");

let parseHTML;
try {
  ({ parseHTML } = await import("linkedom"));
} catch {
  const alt = path.join(ROOT, "..", "padel-livescore", "node_modules", "linkedom", "esm", "index.js");
  ({ parseHTML } = await import(pathToFileURL(alt).href));
}

const fail = [];
const ok = (cond, what) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) fail.push(what); };

// ---- a browser, roughly -----------------------------------------------------
const html = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
const { window, document } = parseHTML(html);

// linkedom has no layout and no visibility, and the app only ever reads .style /
// classList on these, so the defaults are enough.
const loc = new URL("http://localhost/national-teams");
const location = {
  get pathname() { return loc.pathname; },
  get search() { return loc.search; },
  get href() { return loc.href; },
  get origin() { return loc.origin; },
  assign(u) { loc.href = new URL(u, loc).href; },
};
const store = new Map();
const sandbox = {
  window, document, location, console,
  navigator: { userAgent: "node", serviceWorker: undefined, share: undefined },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  history: {
    pushState: (_s, _t, u) => { loc.href = new URL(u, loc).href; },
    replaceState: (_s, _t, u) => { loc.href = new URL(u, loc).href; },
  },
  // Every fetch the app makes is a file under public/. An absent file 404s, which
  // is what the deployed site does for e.g. rankings-elo.json on an old deploy.
  fetch: async (u) => {
    const rel = String(u).split("?")[0].replace(/^\.?\//, "");
    const f = path.join(PUB, rel);
    if (!fs.existsSync(f)) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    const body = fs.readFileSync(f, "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  URL, URLSearchParams, Date, Math, JSON, Intl, Promise, Set, Map, Array, Object, String, Number,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  requestAnimationFrame: (f) => setTimeout(f, 0),
  Notification: undefined,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
for (const k of ["addEventListener", "removeEventListener", "scrollTo", "dispatchEvent"]) {
  sandbox[k] = (window[k] || (() => {})).bind(window);
}

// `state` is a top-level const, so a vm script keeps it in lexical scope rather
// than on the context object. Hand it out explicitly; everything else the test
// touches is a function declaration, which does land on the global — except
// `ntScore`, which is a const arrow for the same reason and is asserted on directly.
const code = fs.readFileSync(path.join(PUB, "app.js"), "utf8") +
  ";globalThis.state = state; globalThis.ntScore = ntScore;";
vm.createContext(sandbox);
new vm.Script(code, { filename: "app.js" }).runInContext(sandbox);

const settle = () => new Promise((r) => setTimeout(r, 60));
await settle();
await settle();

const state = sandbox.state;
const app = document.getElementById("app");

// ---- the route --------------------------------------------------------------
console.log("national teams — headless checks");
ok(state.mode === "natteams", `/national-teams routes to mode "natteams" (got "${state.mode}")`);
ok(!!state.natTeams, "national-teams.json loaded into state");

const d = state.natTeams || { rows: [], events: [], gaps: [] };
ok((d.events || []).length >= 3, `${(d.events || []).length} editions in the data`);
ok((d.rows || []).length >= 50, `${(d.rows || []).length} placings in the data`);
ok((d.gaps || []).length >= 4, `${(d.gaps || []).length} gaps carried in the data`);

// Every row's edition and country must resolve — a dangling ev id would render a
// placing under no championship at all.
const evIds = new Set((d.events || []).map((e) => e.id));
ok((d.rows || []).every((r) => evIds.has(r.ev)), "every placing belongs to a listed edition");
ok((d.rows || []).every((r) => r.iso && r.name && r.c), "every placing carries code, ISO and name");

// ---- the render -------------------------------------------------------------
const out = app.innerHTML;
ok(/data-ntcountry="ESP"/.test(out), "nations render as country links");
ok(/data-tourney="arch"/.test(out) && /data-tkey="fip-135412"/.test(out), "the championship title opens its archived draw");
ok(/data-ntgender="women"/.test(out) && /data-ntcat="Junior"/.test(out), "gender and category chips render");
ok(/<table class="nt-table">/.test(out), "the placings render as a table");
ok(/nt-gap/.test(out), "the not-sourced gaps are shown");

// The default view is men; Denmark did not play the 2024 men's world championship,
// so the men's table for that edition must not mention it.
const menWorld = (d.rows || []).filter((r) => r.ev === "fip-135412" && r.g === "men");
ok(!menWorld.some((r) => r.c === "DEN"), "Denmark absent from the 2024 men's world championship");

// Denmark's two independently sourced placings, as rendered data.
const den = (g, ev) => (d.rows || []).find((r) => r.ev === ev && r.g === g && r.c === "DEN");
ok(den("women", "fip-135412")?.pos === 10, "Denmark 10th, 2024 world championship women");
ok(den("men", "fip-296741")?.pos === 7, "Denmark 7th, 2026 junior Euro Cup men");

// ---- the filters ------------------------------------------------------------
state.ntGender = "women";
sandbox.render();
ok(/Estonia/.test(app.innerHTML), "women's junior Euro Cup lists Estonia (8th)");

state.ntCat = "Junior";
sandbox.render();
ok(!/World Championship 2024/.test(app.innerHTML), "the Junior filter drops the senior world championship");
state.ntCat = "all";
state.ntGender = "men";
sandbox.render();

// ---- where a country click lands --------------------------------------------
// The rule: a nation PadelTicker publishes a ranking for goes to that national
// board; every other nation goes to the FIP world list narrowed to its code. Both
// are checked, because the fallback is what makes all 35 nations clickable.
await sandbox.openCountryRanking("DEN", "DK");
await settle();
ok(state.mode === "rankings" && state.rankFed === "DK" && !state.rankNat, `Denmark -> the Danish ranking (fed ${state.rankFed}, nat "${state.rankNat}")`);
state.mode = "natteams"; state.ntGender = "men";
await sandbox.openCountryRanking("ARG", "AR");
await settle();
ok(state.mode === "rankings" && state.rankFed === "FIP" && state.rankNat === "ARG", `Argentina -> FIP world filtered to ARG (fed ${state.rankFed}, nat "${state.rankNat}")`);
// No nation may land on an empty page: either PadelTicker publishes its national
// board, or its code appears in the FIP world list for the gender being shown.
// (Estonia is the case that makes this worth asserting — no Estonian inside the
// FIP men's top 1000, but /rankings/EE exists, so the click still lands somewhere.)
const lists = state.rankings?.lists || [];
// Placed nations plus the ones listed as "also entered" — those are clickable too,
// and they only have an ISO code because the build script emits a countries map.
const clickable = [
  ...(d.rows || []),
  ...(d.events || []).flatMap((e) =>
    Object.entries(e.unplaced || {}).flatMap(([g, cs]) => cs.map((c) => ({ c, g, iso: (d.countries || {})[c]?.iso })))
  ),
];
ok(clickable.every((r) => r.iso), "every clickable nation, placed or not, carries an ISO code");
const dead = [], unfiltered = [];
for (const r of clickable) {
  state.ntGender = r.g;
  const t = sandbox.countryRankingTarget(r.c, r.iso);
  const list = lists.find((l) => l.fed === t.fed && l.category === t.cat);
  const n = t.nat ? (list?.rows || []).filter((x) => x.country === t.nat).length : (list?.rows || []).length;
  if (!n) dead.push(`${r.c}/${r.g}`);
  if (t.fed === "FIP" && !t.nat) unfiltered.push(r.c);
}
state.ntGender = "men";
ok(dead.length === 0, `every nation click lands on a non-empty list${dead.length ? ` — empty for ${[...new Set(dead)].join(", ")}` : ""}`);
ok(unfiltered.length === 0, `no nation falls through to the unfiltered world list${unfiltered.length ? ` — ${[...new Set(unfiltered)].join(", ")}` : ""}`);
state.mode = "natteams";

// ---- the championship title opens the archived draw -------------------------
// Nothing on the natteams page has loaded the archive index, so this is the cold
// path: openTournament has to fetch t/<key>.json itself and backfill the name.
sandbox.openTournament("arch", "fip-135412", "FIP WORLD PADEL CHAMPIONSHIPS 2024", "");
await settle();
await settle();
ok(Array.isArray(state.tournament?.matches) && state.tournament.matches.length > 200, `the draw loads its matches (${state.tournament?.matches?.length})`);
ok(location.pathname === "/tournament/fip/135412", `the draw sets its own URL (got ${location.pathname})`);
state.tournament = null;
state.mode = "natteams";
sandbox.render();
ok(/nt-table/.test(app.innerHTML), "closing the draw comes back to the national-teams table");

// ---- the URL ----------------------------------------------------------------
ok(sandbox.currentPath() === "/national-teams", "men + all categories is the bare /national-teams path");
state.ntGender = "women"; state.ntCat = "Junior";
ok(sandbox.currentPath() === "/national-teams/women/junior", `women + Junior deep-links (got ${sandbox.currentPath()})`);
state.ntGender = "men"; state.ntCat = "all";

// ---- one nation's own page (Kim, 2026-09-23: a country click opens this, not a ranking)
state.ntCountry = "DEN";
sandbox.render();
let page = app.innerHTML;
ok(/ntc-name/.test(page) && /Denmark/.test(page), "clicking a nation renders its own page");
ok(/2024/.test(page) && /2026/.test(page), "the country page spans every edition it placed in");
ok(/Junior Euro Padel Cup/.test(page) && /World Championship/.test(page), "both of Denmark's championships are listed");
ok(/data-ntrank="DEN"/.test(page), "the ranking is still reachable, from the header button");
ok(/data-ntback/.test(page), "the country page offers a way back");
ok(sandbox.currentPath() === "/national-teams/country/den", `the country page has its own URL (got ${sandbox.currentPath()})`);
sandbox.setTitle();
ok(/Denmark/.test(document.title), `the tab names the nation (got "${document.title}")`);

// Both genders on one page: Denmark's record is 10th (women, 2024) and 7th (men, 2026),
// and the men-only default must not hide half of it.
ok(/Women/.test(page) && /Men/.test(page), "a nation's men's and women's placings share the page");

// Deep link, cold: the path alone must reach the same page.
state.ntCountry = null;
loc.href = new URL("http://localhost/national-teams/country/arg").href;
sandbox.applyRoute();
await settle();
ok(state.mode === "natteams" && state.ntCountry === "ARG", `/national-teams/country/arg deep-links (mode ${state.mode}, country ${state.ntCountry})`);
ok(/Argentina/.test(app.innerHTML), "the deep-linked page renders that nation");

// Every nation that is clickable anywhere must have a page with something on it —
// the empty state is for typed URLs, not for nations we actually link to.
const empties = [];
for (const c of new Set(clickable.map((r) => r.c))) {
  state.ntCountry = c;
  sandbox.render();
  if (/No sourced championship placing/.test(app.innerHTML)) empties.push(c);
}
ok(empties.length === 0, `every clickable nation has a page with content${empties.length ? ` — empty for ${empties.join(", ")}` : ""}`);

// A code nobody played under says so, rather than rendering an empty table that
// reads as "this nation has never placed".
state.ntCountry = "ZZZ";
sandbox.render();
ok(/No sourced championship placing/.test(app.innerHTML), "an unknown country code gets an honest empty state");
ok(!/ntc-table/.test(app.innerHTML), "...and no empty table");

// ---- the matches behind the placings ----------------------------------------
// national-teams-matches.json is fetched only on a country page, so by here the
// pages rendered above have pulled it in.
state.ntCountry = "DEN";
sandbox.render();
await settle();
sandbox.render();
page = app.innerHTML;
const mm = state.natMatches;
ok(!!mm && (mm.matches || []).length > 500, `the match file loaded (${(mm?.matches || []).length} matches)`);
ok(/section-label">Matches/.test(page), "the country page lists the matches behind its placings");
ok(/ntm-squad/.test(page), "...and the players who played them");

// Every match must resolve on both sides, or a row renders against no nation.
const mEvIds = new Set((mm.events || []).map((e) => e.id));
ok((mm.matches || []).every((x) => mEvIds.has(x.ev)), "every match belongs to a listed edition");
ok((mm.matches || []).every((x) => mm.countries[x.a] && mm.countries[x.b] && x.a !== x.b), "every match is one nation against another");
ok((mm.matches || []).every((x) => x.w === x.a || x.w === x.b), "every match names one of the two nations as the winner");
ok((mm.matches || []).every((x) => x.pa.length && x.pb.length), "every match names both pairs");
// A tie is an aggregate of its own rubbers: it cannot claim more wins than were
// played, and it cannot be level — a level tie is dropped by the build, not shipped.
ok((mm.ties || []).every((t) => t.wa + t.wb <= t.n && t.wa !== t.wb && (t.w === t.a || t.w === t.b)), "every tie is decided and adds up");

// Denmark's record, counted from the rows rather than trusted from the header.
const dkm = (mm.matches || []).filter((x) => x.a === "DEN" || x.b === "DEN");
ok(dkm.length > 0, `Denmark has ${dkm.length} matches`);
ok(new RegExp(`Matches<span class="count">${dkm.length}</span>`).test(page), "the header count is the number of rows on the page");

// The score is stored in the draw's side order, and on a nation's page it must read
// "us first" — otherwise a won match prints "4-6 1-6" beside a W. Check it against
// every row the page shows: a winning row's first set number must be the higher one.
const flipped = dkm.filter((x) => x.s && x.b === "DEN").map((x) => sandbox.ntScore(x, "DEN"));
ok(flipped.length > 0, `Denmark is the draw's second side in ${flipped.length} scored matches`);
const wrongWay = dkm.filter((x) => x.s && x.w === "DEN").filter((x) => {
  const [a, b] = sandbox.ntScore(x, "DEN").split(" ")[0].split("-").map(Number);
  return a < b; // a first set the winner lost is possible, so only count the whole row
}).length;
const wonRows = dkm.filter((x) => x.s && x.w === "DEN").length;
ok(wrongWay < wonRows / 2, `won matches print the nation's score first (${wonRows - wrongWay}/${wonRows} lead the first set)`);
ok(sandbox.ntScore({ a: "SWE", b: "DEN", s: "4-6 1-6" }, "DEN") === "6-4 6-1", "a second-side score is turned around");
ok(sandbox.ntScore({ a: "DEN", b: "SWE", s: "6-4 6-1" }, "DEN") === "6-4 6-1", "...and a first-side score is left alone");

// ---- the name join ----------------------------------------------------------
// The rules live in scripts/nt-resolve-players.mjs; these assert the OUTCOME, because
// a wrong link here puts the wrong person in a national team.
const links = mm.players || {};
ok(Object.keys(links).length > 500, `${Object.keys(links).length} printed names resolve to a profile`);

// Every key must be a name that is actually printed somewhere, and every value a
// plausible player id — a stale key would render a link on nothing.
const printed = new Set();
for (const x of mm.matches) {
  for (const n of x.pa) printed.add(`${n}|${x.a}`);
  for (const n of x.pb) printed.add(`${n}|${x.b}`);
}
ok(Object.keys(links).every((k) => printed.has(k)), "every link belongs to a name the draws print");
ok(Object.values(links).every((v) => /^(fip-|R\d)/.test(v)), "every link is a FIP or RankedIn player id");

// The two refusals that matter, asserted by name. "P. Hansen" plays in Denmark's
// MEN's junior team; the only Danish P. Hansen with a full name in the index is
// Pernille Hansen, so an initial-and-surname join alone would link the wrong person.
ok(!links["P. Hansen|DEN"], "P. Hansen (men) is NOT linked to a Danish women's player");
ok(!links["V. Persson|SWE"], "a name printed in both men's and women's matches is not linked");

// A name that appears in both genders can never be linked, whichever pass found it.
const genders = new Map();
for (const x of mm.matches) {
  for (const [n, c] of [...x.pa.map((v) => [v, x.a]), ...x.pb.map((v) => [v, x.b])]) {
    const k = `${n}|${c}`;
    genders.set(k, (genders.get(k) || new Set()).add(x.g));
  }
}
ok([...genders].filter(([k, g]) => g.size > 1).every(([k]) => !links[k]), "no linked name is printed in both genders");

// Two different printed names may share an id (one person, two spellings), but a
// name must never carry two ids — the map shape guarantees it, so assert the risk
// that is real: a link rendered for a name the page does not show.
state.ntCountry = "DEN";
sandbox.render();
const linkedOnPage = [...(app.innerHTML.match(/data-player="[^"]+"/g) || [])];
ok(linkedOnPage.length > 10, `Denmark's page renders ${linkedOnPage.length} player links`);
ok(!/data-player="undefined"/.test(app.innerHTML), "...and none of them is an undefined id");

// The point of the match pass: an edition whose bracket states NO placing is still
// published at match level. Croatia played only the 2024 Europeans.
ok((mm.events || []).some((e) => e.id === "fip-137970" && e.unordered), "the unplaceable 2024 Europeans are in the match file");
state.ntCountry = "CRO";
sandbox.render();
ok(/ntc-name/.test(app.innerHTML) && /Croatia/.test(app.innerHTML), "a nation with matches but no placing still has a page");
ok(!/No sourced championship placing/.test(app.innerHTML), "...and is not shown as having no record");
ok(/European Championship/.test(app.innerHTML), "...listing the edition its matches come from");

// And the hub has to link there, or that page is unreachable.
state.ntCountry = null;
sandbox.render();
ok(/nt-gap-m/.test(app.innerHTML) && /data-ntcountry="CRO"/.test(app.innerHTML), "the gap card links the nations whose matches ARE published");

// Back to the tables.
state.ntCountry = null;
sandbox.render();
ok(/nt-gap/.test(app.innerHTML) && !/ntc-name/.test(app.innerHTML), "back returns to the championship tables");
ok(sandbox.currentPath() === "/national-teams", "...and to the section URL");

// Searching is a search of the tables, so it must leave a country page rather than
// filtering nothing. The listener debounces at 200 ms.
state.ntCountry = "DEN";
sandbox.render();
const qbox = document.getElementById("q");
qbox.value = "spain";
qbox.dispatchEvent(new window.Event("input"));
await new Promise((r) => setTimeout(r, 400));
ok(state.ntCountry === null, "typing in the search box leaves the country page");
ok(sandbox.currentPath() === "/national-teams", "...and the URL follows");
state.query = ""; qbox.value = "";
sandbox.render();

console.log(fail.length ? `\n${fail.length} FAILED` : "\nall headless checks passed");
process.exit(fail.length ? 1 : 0);
