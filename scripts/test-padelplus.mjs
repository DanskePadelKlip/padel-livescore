// Offline tests for src/padelplus.js — Padel+ rubber rows -> poll_live.py board TSV.
// No network: boardCols() and diffRows() are pure.
//   node scripts/test-padelplus.mjs

import { boardCols, diffRows, pointLabels, setsWon, stamp } from "../src/padelplus.js";

let pass = 0, fail = 0;
const eq = (a, b, name) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) pass++; else { fail++; console.log(`  FAIL  ${name}\n        got  ${A}\n        want ${B}`); }
};

const st = (o) => ({ mode: "game", sets: [[0, 0]], points: [0, 0], server: 0, first_server: 0, winner: null, deuces: 0, ...o });
const row = (o) => ({ kampdag_id: "k1", rankedin_match_id: 152605, position: 3, format: { deuce: "golden", decider: false, third_set: "full" },
  court_label: "BetaPack Banen", phase: "live", version: 10, winner: null, updated_at: "2026-10-16T18:20:01.5+00:00", tastning: "point", state: st(), ...o });

console.log("point labels");
eq(pointLabels(st({ points: [0, 0] })), ["0", "0"], "0-0");
eq(pointLabels(st({ points: [2, 1] })), ["30", "15"], "30-15");
eq(pointLabels(st({ points: [3, 3] })), ["40", "40"], "deuce / golden point");
eq(pointLabels(st({ points: [4, 3] })), ["AD", "40"], "advantage home");
eq(pointLabels(st({ points: [5, 6] })), ["40", "AD"], "advantage away after more deuces");
eq(pointLabels(st({ points: [4, 4] })), ["40", "40"], "back to deuce");
eq(pointLabels(st({ mode: "tiebreak", points: [5, 4] })), ["5", "4"], "tiebreak counts");
eq(pointLabels(st({ mode: "match_tiebreak", points: [8, 10] })), ["8", "10"], "match tiebreak counts");

console.log("sets won");
eq(setsWon(st({ sets: [[6, 3], [2, 1]] })), [1, 0], "set in play is not counted");
eq(setsWon(st({ sets: [[4, 6], [6, 4], [6, 0]], winner: 0 })), [2, 1], "finished: every set counts");
eq(setsWon(st({ sets: [[7, 6], [6, 7], [0, 0]] })), [1, 1], "a fresh third set at 0-0");

console.log("board columns (poll_live.py shape)");
eq(boardCols(row({ state: st({ sets: [[6, 3], [2, 1]], points: [1, 2], server: 1 }) })), ["1:0", "6-3,2-1", "15:30", "2", "2"], "in play, away serving");
eq(boardCols(row({ phase: "done", winner: "home", state: st({ sets: [[6, 2], [6, 4]], winner: 0 }) })), ["2:0", "6-2,6-4", "0:0", "1", "4"], "finished -> status 4");
eq(stamp("2026-10-16T18:27:57.96739+00:00"), "2026-10-16T18:27:57.967+00:00", "timestamp is python isoformat, ms, +00:00");

console.log("diffRows: one line per new version, gaps and undos flagged");
{
  const last = new Map();
  const a = diffRows(last, [row({ version: 10 })]);
  eq(a.length, 1, "first sighting writes");
  eq(a[0].lines.length, 2, "start comment + row");
  eq(a[0].lines[0].startsWith("# 2026-10-16T18:20:01.500+00:00 start tie 152605 p3 | court BetaPack Banen"), true, "start comment names tie, position, court");
  eq(a[0].lines[1], "2026-10-16T18:20:01.500+00:00\t0:0\t0-0\t0:0\t1\t2", "board row");
  eq(diffRows(last, [row({ version: 10 })]).length, 0, "same version again writes nothing");
  const b = diffRows(last, [row({ version: 11, updated_at: "2026-10-16T18:20:30Z", state: st({ points: [1, 0] }) })]);
  eq(b[0].lines, ["2026-10-16T18:20:30.000+00:00\t0:0\t0-0\t15:0\t1\t2"], "next version: just the row");
  eq(diffRows(last, [row({ version: 14 })])[0].lines[0], "# gap v11->v14", "missed versions are flagged");
  eq(diffRows(last, [row({ version: 13 })])[0].lines[0], "# back v14->v13", "an undo is flagged and still written");
  const two = diffRows(last, [row({ version: 15 }), row({ position: 4, version: 1 })]);
  eq(two.map((w) => w.key), ["152605:p3", "152605:p4"], "rubbers are tracked separately");
  eq(diffRows(last, [null, { state: null }, row({ position: null })]).length, 0, "junk rows are skipped");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
