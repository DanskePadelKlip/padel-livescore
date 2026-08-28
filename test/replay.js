#!/usr/bin/env node
// Offline test path for the changeover stats overlay.
//
//   node test/replay.js
//
// Replays a REAL captured sporteaser day payload through the accumulator with
// synthetic time, one point at a time, exactly as the live poller would have seen
// it unfold. That makes the changeover detection and the stat maths testable
// without waiting for a tournament to be on court.
//
// Fixtures (test/fixtures/sporteaser-397-day{26,28,29}.json) are untouched
// captures of FIP Gold Belgrade 2026, sporteaser tournamentId 397, taken
// 2026-08-29. Day 29 is included precisely because it has NO point history yet
// (its matches had not started) — the "no live scoring to show" case is a normal
// outcome the overlay has to survive, not an error.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createState, ingest, fromSporteaser, exactFromLog, detectTrigger,
  freshSampled, sampleStep, TRIGGER,
} from "../public/overlay/accumulator.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (day) => JSON.parse(readFileSync(join(HERE, "fixtures", `sporteaser-397-day${day}.json`), "utf8"));

// ---- tiny assertion kit ----------------------------------------------------

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---- replayer --------------------------------------------------------------

const PERIODS = ["First", "Second", "Third", "Fourth", "Fifth"];
const START = Date.UTC(2026, 7, 26, 7, 0, 0);   // synthetic clock — no Date.now() anywhere
const SECONDS_PER_POINT = 25;

/**
 * Expand one finished sporteaser match record into the sequence of payloads the
 * live feed would have served while it was being played: one after every point,
 * plus one at each game boundary (where the game gains its score and the current
 * game score resets).
 */
function* replay(match) {
  const log = match.pointHistory?.results || [];
  let t = START;
  const games = [];   // per set: running [home, away]

  for (let si = 0; si < log.length; si++) {
    games[si] = [0, 0];
    const setGames = log[si] || [];
    for (let gi = 0; gi < setGames.length; gi++) {
      const g = setGames[gi];
      if (!g) continue;
      const tb = !!g.status?.isTieBreak;
      const pts = g.points || [];

      // in-progress states, one payload per logged point
      for (let pi = 0; pi < pts.length; pi++) {
        t += SECONDS_PER_POINT * 1000;
        const [a, b] = String(pts[pi].value).split(":");
        yield { at: t, raw: build(match, log, si, gi, pi, games, [a, b], tb) };
      }
      // the game completes: score lands, current game resets to 0:0
      if (g.score) {
        t += SECONDS_PER_POINT * 1000;
        games[si] = [g.score.matchHometeamGameScore ?? games[si][0], g.score.matchAwayteamGameScore ?? games[si][1]];
        yield { at: t, raw: build(match, log, si, gi, pts.length, games, ["0", "0"], tb, true) };
      }
    }
  }
}

/** A truncated payload: everything up to (set si, game gi, point pi). */
function build(match, log, si, gi, pi, games, cur, tb, gameDone = false) {
  const results = { teamInPossession: null, matchHomeTeamCurrentStatus: cur[0], matchAwayTeamCurrentStatus: cur[1] };
  for (let i = 0; i <= si; i++) {
    const [h, a] = games[i] || [0, 0];
    if (h || a) {
      results[`matchHomeTeam${PERIODS[i]}PeriodScore`] = h;
      results[`matchAwayTeam${PERIODS[i]}PeriodScore`] = a;
    }
  }
  const cut = [];
  for (let i = 0; i <= si; i++) {
    const setGames = (log[i] || []).slice(0, i === si ? gi + 1 : undefined);
    cut.push(
      setGames.map((g, k) => {
        if (i < si || k < gi) return g;                                  // already complete
        const partial = { status: g.status, points: (g.points || []).slice(0, pi) };
        return gameDone ? { ...partial, points: g.points || [], score: g.score } : partial;
      })
    );
  }
  return {
    ...match,
    matchStatus: 2,                                                       // live
    results,
    pointHistory: { results: cut, meta: match.pointHistory?.meta },
  };
}

/** Drive a whole match through the accumulator, collecting triggers. */
function runMatch(match) {
  const state = createState(String(match.id));
  const triggers = [];
  let last = null;
  for (const { at, raw } of replay(match)) {
    const obs = fromSporteaser(raw, at);
    const { trigger, stats } = ingest(state, obs);
    if (trigger) triggers.push(trigger);
    last = stats;
  }
  return { state, triggers, stats: last };
}

const setsOf = (m) => {
  const r = m.results || {};
  const out = [];
  for (const p of PERIODS) {
    const h = r[`matchHomeTeam${p}PeriodScore`], a = r[`matchAwayTeam${p}PeriodScore`];
    if (h === undefined && a === undefined) break;
    out.push([h ?? 0, a ?? 0]);
  }
  return out;
};

// ---------------------------------------------------------------------------
// case 1 — a normal set to 6-4
// ---------------------------------------------------------------------------

function caseNormalSet() {
  console.log("\ncase 1 — normal set to 6-4 (changeover count, holds/breaks)");
  const all = [...fixture(26).matches, ...fixture(28).matches];
  const m = all.find((x) => {
    const s = setsOf(x);
    const hasTB = (x.pointHistory?.results || []).some((set) => (set || []).some((g) => g?.status?.isTieBreak));
    return !hasTB && s.length && Math.max(s[0][0], s[0][1]) === 6 && Math.min(s[0][0], s[0][1]) === 4;
  });
  if (!m) return check("a 6-4 first set exists in the fixtures", false);
  console.log(`  match ${m.id}: ${m.homeTeam.name} vs ${m.awayTeam.name}  ${setsOf(m).map((s) => s.join("-")).join(" ")}`);

  const { triggers, stats } = runMatch(m);
  const inSet0 = triggers.filter((t) => t.setIndex === 0);
  const changeovers = inSet0.filter((t) => t.kind === TRIGGER.CHANGEOVER);
  // 10 games -> sides change after games 3, 5, 7 and 9 (no sit-down after game 1),
  // then the set break.
  eq("changeovers in a 10-game set", changeovers.length, 4);
  eq("changeovers land on odd game totals", changeovers.map((t) => t.games).join(","), "3,5,7,9");
  eq("the completed set raises exactly one set break", inSet0.filter((t) => t.kind === TRIGGER.SET_BREAK).length, 1);
  check("no changeover after the first game of a set", !changeovers.some((t) => t.games === 1));

  const e = stats.exact;
  check("serve reconstruction is confident", e.serve.reliable, `confidence ${e.serve.confidence.toFixed(2)}`);
  eq("games won equals games played", e.games.won[0] + e.games.won[1], e.games.played);
  // Every completed non-tiebreak game is either a hold by its server or a break by
  // the returner — the two tallies must reconstruct the games-served count exactly.
  eq("side A service games = holds A + breaks B", e.served[0], e.holds[0] + e.breaks[1]);
  eq("side B service games = holds B + breaks A", e.served[1], e.holds[1] + e.breaks[0]);
  eq("service games alternate to within one", Math.abs(e.served[0] - e.served[1]) <= 1, true);
  eq("service points played = total points", e.servePoints[0].played + e.servePoints[1].played, e.points[0] + e.points[1]);
  check("break points saved never exceed faced",
    e.bp[0].saved <= e.bp[0].faced && e.bp[1].saved <= e.bp[1].faced,
    JSON.stringify(e.bp));
  check("our break-point calls agree with the feed's own BP markers",
    e.bpMarkerAgreement > 0.9, `agreement ${(e.bpMarkerAgreement * 100).toFixed(1)}%`);
  eq("momentum holds at most the last 6 games", e.momentum.length <= 6, true);
  console.log(`  holds ${e.holds.join("/")}  breaks ${e.breaks.join("/")}  points ${e.points.join("-")}  ` +
              `BP ${e.bp.map((x) => `${x.saved}/${x.faced}`).join(" ")}  serve fit ${(e.serve.confidence * 100).toFixed(0)}%`);
}

// ---------------------------------------------------------------------------
// case 2 — a tiebreak set
// ---------------------------------------------------------------------------

function caseTiebreak() {
  console.log("\ncase 2 — tiebreak set (changeover every 6 points, TB maths)");
  const all = [...fixture(26).matches, ...fixture(28).matches];
  const m = all.find((x) => (x.pointHistory?.results || []).some((s) => (s || []).some((g) => g?.status?.isTieBreak)));
  if (!m) return check("a tiebreak exists in the fixtures", false);
  console.log(`  match ${m.id}: ${setsOf(m).map((s) => s.join("-")).join(" ")}`);

  const { triggers, stats } = runMatch(m);
  const tbTriggers = triggers.filter((t) => t.kind === TRIGGER.TIEBREAK);
  const e = stats.exact;
  const tb = e.tiebreaks[0];
  check("a tiebreak was recorded", !!tb, JSON.stringify(e.tiebreaks));
  if (!tb) return;

  const tbPoints = tb.points[0] + tb.points[1];
  // Sides change after every 6th point: 6, 12, 18 ...
  eq("tiebreak changeovers", tbTriggers.length, Math.floor(tbPoints / 6));
  check("a tiebreak is won by 7+ with two clear",
    Math.max(...tb.points) >= 7 && Math.abs(tb.points[0] - tb.points[1]) >= 2,
    `tiebreak ${tb.points.join("-")}`);
  eq("the tiebreak winner is the side with more points", tb.winner, tb.points[0] > tb.points[1] ? 0 : 1);
  // The tiebreak counts as one game for the serve rotation but is nobody's
  // service game, so it must not land in the hold/break tally.
  eq("side A service games = holds A + breaks B", e.served[0], e.holds[0] + e.breaks[1]);
  eq("side B service games = holds B + breaks A", e.served[1], e.holds[1] + e.breaks[0]);
  eq("the tiebreak is excluded from service games", e.served[0] + e.served[1], e.games.played - e.tiebreaks.filter((t) => t.complete).length);
  console.log(`  tiebreak ${tb.points.join("-")} to side ${tb.winner}, ${tbTriggers.length} mid-tiebreak change(s)`);
}

// ---------------------------------------------------------------------------
// case 3 — the sampled tier survives a poll gap by admitting it
// ---------------------------------------------------------------------------

// State-only observations, the shape a Crionet feed produces: set games, the
// current game score, a serve marker, and no point log at all.
const stateObs = (at, sets, points, serving) => ({ at, sets, points, serving, log: null, status: "live", teams: null });

function caseSampledGap() {
  console.log("\ncase 3 — sampled tier, poll gap during a game");

  // Two identical games, both won to love by the server. In the second one the
  // poller misses the 15-30 state, so the point log jumps two steps at once.
  const clean = [["0", "0"], ["15", "0"], ["30", "0"], ["40", "0"]];
  const gappy = [["0", "0"], ["15", "0"], ["40", "0"]];

  const run = (seq, setsBefore, setsAfter) => {
    let s = freshSampled(), prev = null, t = START;
    for (const p of seq) {
      const obs = stateObs((t += 25000), setsBefore, p, 0);
      s = sampleStep(s, prev, obs);
      prev = obs;
    }
    const end = stateObs((t += 25000), setsAfter, ["0", "0"], 1);
    s = sampleStep(s, prev, end);
    return s;
  };

  const good = run(clean, [[0, 0]], [[1, 0]]);
  eq("a fully observed game is counted", good.gamesCounted, 1);
  eq("no game marked unreliable", good.gamesUnreliable, 0);
  eq("all four points counted to the winner", good.points[0], 4);
  eq("service points recorded", good.servePlayed, 4);

  const bad = run(gappy, [[0, 0]], [[1, 0]]);
  eq("a game with a dropped point is NOT counted", bad.gamesCounted, 0);
  eq("it is marked unreliable instead", bad.gamesUnreliable, 1);
  eq("its points are excluded from the totals rather than reported short", bad.points[0], 0);
  check("the wrong total (3) is never reported", bad.points[0] !== 3, `points ${bad.points.join("-")}`);

  // A short game the poller saw entirely, but where the winner cannot have won it:
  // the reconciliation floor catches it even with no visible step jump.
  let s = freshSampled(), prev = null, t = START;
  for (const p of [["0", "0"], ["15", "0"]]) {
    const obs = stateObs((t += 25000), [[0, 0]], p, 0);
    s = sampleStep(s, prev, obs);
    prev = obs;
  }
  s = sampleStep(s, prev, stateObs(t + 25000, [[1, 0]], ["0", "0"], 1));
  eq("a game won on too few observed points is unreliable", s.gamesUnreliable, 1);
  eq("and contributes nothing to the totals", s.points[0] + s.points[1], 0);
}

// ---------------------------------------------------------------------------
// case 4 — an event with no live scoring is a normal outcome, not an error
// ---------------------------------------------------------------------------

function caseNoScoring() {
  console.log("\ncase 4 — a day with no point history at all");
  const day29 = fixture(29).matches;
  check("day 29 has matches but no point log", day29.length > 0 && day29.every((m) => !m.pointHistory));
  const obs = fromSporteaser(day29[0], START);
  eq("it normalizes without throwing", obs.status, "upcoming");
  eq("no exact tier is invented from nothing", exactFromLog(obs.log), null);
  eq("no current game score is published for a match not on court", obs.points, null);
  const state = createState(obs.matchId);
  const { trigger } = ingest(state, obs);
  eq("an upcoming match raises no changeover", trigger, null);
  check("a second poll of the same state still raises nothing", ingest(state, { ...obs, at: START + 3000 }).trigger === null);
}

// ---------------------------------------------------------------------------
// case 5 — trigger de-duplication and the set-break edge
// ---------------------------------------------------------------------------

function caseTriggerEdges() {
  console.log("\ncase 5 — trigger edges");
  const at = START;
  const live = (sets, points) => ({ at, sets, points: points || null, serving: 0, log: null, status: "live", teams: null });

  eq("no trigger without a previous observation", detectTrigger(null, live([[2, 1]])), null);
  eq("no trigger on an even game total", detectTrigger(live([[1, 0]]), live([[1, 1]])), null);
  eq("game 1 changes ends but does not sit down", detectTrigger(live([[0, 0]]), live([[1, 0]])), null);
  eq("game 3 total fires a changeover", detectTrigger(live([[2, 0]]), live([[2, 1]]))?.kind, TRIGGER.CHANGEOVER);
  eq("game 5 too", detectTrigger(live([[3, 1]]), live([[3, 2]]))?.kind, TRIGGER.CHANGEOVER);
  eq("a completed set fires the set break, not a changeover",
    detectTrigger(live([[5, 4]]), live([[6, 4]]))?.kind, TRIGGER.SET_BREAK);
  eq("7-5 is a completed set too", detectTrigger(live([[6, 5]]), live([[7, 5]]))?.kind, TRIGGER.SET_BREAK);
  eq("6-5 is not", detectTrigger(live([[5, 5]]), live([[6, 5]]))?.kind, TRIGGER.CHANGEOVER);
  eq("a new set appearing also fires the set break",
    detectTrigger(live([[6, 4]]), live([[6, 4], [0, 0]]))?.kind, TRIGGER.SET_BREAK);
  eq("a finished match raises nothing",
    detectTrigger(live([[5, 4]]), { ...live([[6, 4]]), status: "final" }), null);

  // de-duplication: the same state polled repeatedly must fire exactly once
  const state = createState("dedupe");
  ingest(state, live([[2, 0]]));
  const first = ingest(state, { ...live([[2, 1]]), at: at + 3000 }).trigger;
  const again = ingest(state, { ...live([[2, 1]]), at: at + 6000 }).trigger;
  const third = ingest(state, { ...live([[2, 1]]), at: at + 9000 }).trigger;
  check("the changeover fires once", !!first);
  check("and not again on the next poll", !again && !third);
}

// ---------------------------------------------------------------------------
// case 6 — every match in the fixtures replays cleanly
// ---------------------------------------------------------------------------

function caseWholeFixture() {
  console.log("\ncase 6 — replay every played match in the fixtures");
  const all = [...fixture(26).matches, ...fixture(28).matches].filter((m) => m.pointHistory?.results?.length);
  let bad = 0, lowConfidence = 0, totalGames = 0;
  const problems = [];
  for (const m of all) {
    const { stats } = runMatch(m);
    const e = stats.exact;
    if (!e) { bad++; problems.push(`${m.id}: no exact tier`); continue; }
    totalGames += e.games.played;
    if (!e.serve.reliable) lowConfidence++;
    const ok =
      e.served[0] === e.holds[0] + e.breaks[1] &&
      e.served[1] === e.holds[1] + e.breaks[0] &&
      e.servePoints[0].played + e.servePoints[1].played === e.points[0] + e.points[1] &&
      e.bp.every((x) => x.saved <= x.faced) &&
      e.games.won[0] + e.games.won[1] === e.games.played;
    if (!ok) { bad++; problems.push(`${m.id}: ${JSON.stringify({ served: e.served, holds: e.holds, breaks: e.breaks })}`); }
  }
  eq(`all ${all.length} matches (${totalGames} games) are internally consistent`, bad, 0);
  if (problems.length) console.log("   " + problems.slice(0, 5).join("\n   "));
  console.log(`  ${lowConfidence}/${all.length} match(es) below the serve-confidence floor — those demote their serve stats`);
}

// ---------------------------------------------------------------------------

console.log("changeover stats overlay — offline replay");
caseNormalSet();
caseTiebreak();
caseSampledGap();
caseNoScoring();
caseTriggerEdges();
caseWholeFixture();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(1);
}
