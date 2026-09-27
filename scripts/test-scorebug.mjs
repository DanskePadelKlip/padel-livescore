// Unit tests for the organiser-scorebug overlay. The paths that matter are the ones live
// data does not reliably reproduce: PROMOTION of a Crionet-blank match (the module's whole
// reason to exist), the final-match guard, orientation, and the ambiguity rule — which
// carries more weight now that candidates are every non-final match, not just live ones.
import assert from "node:assert/strict";
import { attach } from "../src/adapters/scorebug.js";

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

// FIP writes "B. Espino Mustafa"; the scorebug stores bare surnames ("Espino").
const mkMatch = (o = {}) => ({
  id: o.id || "fip:1",
  source: "fip",
  status: o.status || "upcoming",
  court: o.court ?? "CENTRE COURT",
  estStart: "17:00",
  estStartAt: "2026-09-27T15:00:00Z",
  teams: [
    { players: (o.a || ["B. Espino Mustafa", "P. Lijo"]).map((n) => ({ name: n })) },
    { players: (o.b || ["A. Coello Manso", "A. Tapia"]).map((n) => ({ name: n })) },
  ],
  score: o.score || { sets: [], winner: null },
});

const mkState = (o = {}) => ({
  status: o.status || "live",
  seq: o.seq ?? 12,
  server: o.server ?? 0,
  points: o.points || [2, 1],           // 30 - 15
  games: o.games || [3, 2],
  sets: o.sets || [{ a: 6, b: 4 }],
  teams: [
    { players: (o.a || ["Espino", "Lijo"]).map((n) => ({ name: n })) },
    { players: (o.b || ["Coello", "Tapia"]).map((n) => ({ name: n })) },
  ],
});

console.log("\npromotion — the Crionet-blank court this module exists for");

ok("an UPCOMING match the scorebug has on court is promoted to live", () => {
  const m = mkMatch({ status: "upcoming" });
  assert.equal(attach([m], mkState()), 1);
  assert.equal(m.status, "live");
  assert.deepEqual(m.score.points, ["30", "15"]);
  assert.deepEqual(m.score.sets, [["6", "4"], ["3", "2"]]);
  assert.equal(m.score.serving, 0);
  assert.equal(m.raw.liveSource, "scorebug");
});

ok("promotion clears the estimated start the scheduler chained", () => {
  const m = mkMatch({ status: "upcoming" });
  attach([m], mkState());
  assert.equal(m.estStart, null);
  assert.equal(m.estStartAt, null);
});

ok("a match Crionet already calls live is still enriched", () => {
  const m = mkMatch({ status: "live" });
  assert.equal(attach([m], mkState()), 1);
  assert.equal(m.status, "live");
  assert.deepEqual(m.score.points, ["30", "15"]);
});

console.log("\nguards");

ok("a FINAL match is never touched — the OOP owns completed matches", () => {
  const m = mkMatch({ status: "final", score: { sets: [["6", "4"], ["6", "3"]], winner: 0 } });
  assert.equal(attach([m], mkState()), 0);
  assert.equal(m.status, "final");
  assert.deepEqual(m.score.sets, [["6", "4"], ["6", "3"]]);
});

ok("a scorebug that is not live promotes nothing", () => {
  const m = mkMatch({ status: "upcoming" });
  assert.equal(attach([m], mkState({ status: "idle" })), 0);
  assert.equal(m.status, "upcoming");
});

ok("two non-final matches with the same pairing: ambiguous, neither promoted", () => {
  const a = mkMatch({ id: "fip:1", status: "upcoming" });
  const b = mkMatch({ id: "fip:2", status: "upcoming" });
  assert.equal(attach([a, b], mkState()), 0);
  assert.equal(a.status, "upcoming");
  assert.equal(b.status, "upcoming");
});

ok("a different pairing is not promoted", () => {
  const m = mkMatch({ status: "upcoming", a: ["J. Lebron", "F. Belasteguin"] });
  assert.equal(attach([m], mkState()), 0);
  assert.equal(m.status, "upcoming");
});

ok("a stale scorebug never rolls the set score backwards", () => {
  const m = mkMatch({ status: "live", score: { sets: [["6", "4"], ["5", "3"]], winner: null } });
  attach([m], mkState({ sets: [{ a: 6, b: 4 }], games: [1, 0] })); // fewer total games
  assert.deepEqual(m.score.sets, [["6", "4"], ["5", "3"]]);
});

console.log("\norientation");

ok("a FLIPPED board promotes with sets, points and serve in the MATCH's order", () => {
  const m = mkMatch({ status: "upcoming" });
  // Board lists Coello/Tapia first; the match lists Espino/Lijo first.
  const st = mkState({ a: ["Coello", "Tapia"], b: ["Espino", "Lijo"], points: [2, 1], server: 0 });
  assert.equal(attach([m], st), 1);
  assert.equal(m.status, "live");
  assert.deepEqual(m.score.points, ["15", "30"]);
  assert.deepEqual(m.score.sets, [["4", "6"], ["2", "3"]]);
  assert.equal(m.score.serving, 1);
});

console.log(`\n${pass} assertions passed\n`);
