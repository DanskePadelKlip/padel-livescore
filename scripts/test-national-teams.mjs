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
// touches is a function declaration, which does land on the global.
const code = fs.readFileSync(path.join(PUB, "app.js"), "utf8") + ";globalThis.state = state;";
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

// ---- the URL ----------------------------------------------------------------
ok(sandbox.currentPath() === "/national-teams", "men + all categories is the bare /national-teams path");
state.ntGender = "women"; state.ntCat = "Junior";
ok(sandbox.currentPath() === "/national-teams/women/junior", `women + Junior deep-links (got ${sandbox.currentPath()})`);
state.ntGender = "men"; state.ntCat = "all";

console.log(fail.length ? `\n${fail.length} FAILED` : "\nall headless checks passed");
process.exit(fail.length ? 1 : 0);
