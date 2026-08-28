#!/usr/bin/env node
// Offline render check for the overlay's cards.
//
//   node test/render.js
//
// A dev server cannot be started in an unattended run, so instead of loading the
// page in a browser this builds a synthetic DOM with linkedom, imports the real
// public/overlay/stats.js against it, and renders every card from stats replayed
// out of the real fixtures. It catches what actually breaks on air: a card that
// throws, a card that renders "undefined"/"NaN", and — the one that matters most
// — a SAMPLED number reaching the screen without its approximate label.
//
// It does not prove the CSS looks right. Positioning still wants a human and an
// OBS preview; see STATS-OVERLAY.md.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";
import {
  createState, ingest, fromSporteaser, freshSampled, sampleStep, TRIGGER,
} from "../public/overlay/accumulator.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- a DOM for the module to render into -----------------------------------

// No #stage in this document, so stats.js will NOT boot its poll loop — the
// guard at the bottom of that file is what makes this test possible.
const bare = parseHTML("<!doctype html><html><body></body></html>");

globalThis.document = bare.document;
globalThis.window = bare.window;
globalThis.location = { search: "?tid=397&day=26&sampled=1" };
globalThis.DOMParser = bare.DOMParser;
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.HTMLElement = bare.HTMLElement;

const { CARDS, renderCard, chooseCards, parseCrionetBoards } = await import("../public/overlay/stats.js");

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---- replay a real match to get real stats ---------------------------------

const day = JSON.parse(readFileSync(join(HERE, "fixtures", "sporteaser-397-day26.json"), "utf8"));
const match = day.matches.find((m) => m.pointHistory?.results?.length >= 2);
const state = createState(String(match.id));
let stats = null;
// Feed the finished record straight through — the accumulator derives the exact
// tier from the whole point log in one pass, so one ingest is enough here (the
// point-by-point path is what test/replay.js covers).
{
  const obs = fromSporteaser(match, Date.UTC(2026, 7, 26, 7, 0, 0));
  obs.status = "live";
  stats = ingest(state, obs).stats;
}

console.log("changeover stats overlay — offline render");
console.log(`\ncards from match ${match.id} (${stats.sets.map((s) => s.join("-")).join(" ")})`);

const BAD = /undefined|NaN|\[object Object\]|null/;
const rendered = {};

for (const name of Object.keys(CARDS)) {
  let def = null, html = null, threw = null;
  try {
    def = CARDS[name](stats);
    if (def) html = renderCard(def, stats).outerHTML;
  } catch (err) { threw = err; }
  check(`card "${name}" builds without throwing`, !threw, threw && threw.message);
  if (!def) { console.log(`       (not renderable for this match — skipped, which is a valid outcome)`); continue; }
  rendered[name] = html;
  check(`card "${name}" renders no placeholder text`, !BAD.test(html || ""),
    (html || "").match(BAD)?.[0]);
  check(`card "${name}" names both sides`, (html || "").includes("names"));
}

// The context card needs the D1 APIs; unreachable here, so it must decline
// rather than render an empty shell.
check("context card declines when nothing resolved", CARDS.context(stats) === null);

// ---- the rule that must never break ----------------------------------------

console.log("\nsampled numbers are always labelled");
{
  // Build a sampled-tier stats object the way a Crionet feed would.
  let s = freshSampled(), prev = null, t = Date.UTC(2026, 7, 26, 7, 0, 0);
  const obsOf = (sets, points, serving) => ({ at: (t += 25000), sets, points, serving, log: null, status: "live", teams: null });
  for (const p of [["0", "0"], ["15", "0"], ["30", "0"], ["40", "0"]]) {
    const o = obsOf([[0, 0]], p, 0);
    s = sampleStep(s, prev, o);
    prev = o;
  }
  s = sampleStep(s, prev, obsOf([[1, 0]], ["0", "0"], 1));

  const sampledStats = { ...stats, exact: null, sampled: s };
  for (const name of ["points", "serve"]) {
    const def = CARDS[name](sampledStats);
    check(`sampled "${name}" card is produced`, !!def);
    if (!def) continue;
    const html = renderCard(def, sampledStats).outerHTML;
    check(`sampled "${name}" card carries the approximate label`,
      html.includes("foot approx") && /Approximate/i.test(html));
  }

  // ...and with sampled=1 absent, the sampled tier must not render at all.
  // CFG was read at import time, so this is checked by construction instead:
  // both sampled branches are guarded by CFG.sampled — assert the exact tier
  // never picks up the approximate footer.
  const exactCard = CARDS.points(stats);
  const exactHtml = renderCard(exactCard, stats).outerHTML;
  check("the exact tier never carries an approximate label", !exactHtml.includes("foot approx"));
}

// ---- card rotation ---------------------------------------------------------

console.log("\nrotation");
{
  const first = chooseCards(TRIGGER.CHANGEOVER, stats, null, 0).map((c) => c.k);
  const second = chooseCards(TRIGGER.CHANGEOVER, stats, null, 1).map((c) => c.k);
  check("a changeover offers at least two cards", first.length >= 2, first.join(","));
  const setBreak = chooseCards(TRIGGER.SET_BREAK, stats, null, 0).map((c) => c.k);
  check("a set break leads with the games card", setBreak[0] === "games", setBreak.join(","));
  check("consecutive changeovers do not repeat the same order",
    first.length < 3 || first.join(",") !== second.join(","), `${first.join(",")} vs ${second.join(",")}`);
  console.log(`  changeover: ${first.join(" → ")}`);
  console.log(`  set break : ${setBreak.join(" → ")}`);
}

// ---- the crionet path ------------------------------------------------------

console.log("\ncrionet live board");
{
  // A REAL capture, taken 2026-08-29 from FIP-2026-3507 with nothing on court.
  // That is the state the overlay sees most of the time, so it has to be boring
  // rather than fatal. No fixture of a POPULATED board exists: no FIP event
  // anywhere on tour had a live Crionet board during this build (see
  // STATS-OVERLAY.md — the crionet path is unverified against live markup).
  const html = readFileSync(join(HERE, "fixtures", "crionet-tournamentlive-empty.html"), "utf8");
  const boards = parseCrionetBoards(html);
  check("an empty live board parses to zero matches, not an error", Array.isArray(boards) && boards.length === 0,
    `${boards.length} board(s)`);
  check("garbage markup does not throw either", Array.isArray(parseCrionetBoards("<p>nope</p>")));
  check("an empty string does not throw either", Array.isArray(parseCrionetBoards("")));
}

// ---- a sample of the real markup, for the record ---------------------------

if (rendered.serve) {
  const text = rendered.serve.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  console.log(`\nserve card reads: ${text}`);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(1);
}
