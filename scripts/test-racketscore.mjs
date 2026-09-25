// Unit tests for the paths live data does not reliably exercise: flipped orientation,
// the finished-board path, the guards, and the Danish name fold.
import assert from "node:assert/strict";
import { attach } from "../src/adapters/racketscore.js";

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

const mkMatch = (o = {}) => ({
  id: o.id || "rankedin:1",
  source: "rankedin",
  status: o.status || "upcoming",
  court: o.court ?? "CC",
  estStart: "17:00",
  estStartAt: "2026-09-12T15:00:00Z",
  teams: [
    { name: "A", players: (o.a || ["Jakob Hjorth", "Daniel Stisen"]).map((n) => ({ name: n })) },
    { name: "B", players: (o.b || ["Emil Okkels", "William Søby"]).map((n) => ({ name: n })) },
  ],
  score: o.score || { sets: [], winner: null },
});

const mkBoard = (o = {}) => ({
  boardId: o.boardId || "BRD1",
  slug: "ev",
  state: o.state || "live",
  court: o.court ?? "D1",
  round: "SF",
  category: "Herrer DPF500",
  teams: [
    {
      won: !!o.wonA,
      points: o.ptsA ?? 40,
      games: (o.gamesA || [6, 3]).map((v) => ({ v, setWinner: false })),
      players: (o.a || ["Jakob Hjorth", "Daniel Stisen"]).map((n) => ({ name: n, country: "DK" })),
    },
    {
      won: !!o.wonB,
      points: o.ptsB ?? 30,
      games: (o.gamesB || [4, 5]).map((v) => ({ v, setWinner: false })),
      players: (o.b || ["Emil Okkels", "William Søby"]).map((n) => ({ name: n, country: "DK" })),
    },
  ],
});

console.log("\nattach() — orientation");
ok("same order: sets and points are not swapped", () => {
  const m = mkMatch();
  assert.equal(attach([m], [mkBoard()]), 1);
  assert.deepEqual(m.score.sets, [[6, 4], [3, 5]]);
  assert.deepEqual(m.score.points, ["40", "30"]);
  assert.equal(m.status, "live");
});
ok("FLIPPED board: sets, points and winner follow the MATCH's team order", () => {
  const m = mkMatch();
  // board lists the sides the other way round
  const b = mkBoard({ a: ["Emil Okkels", "William Søby"], b: ["Jakob Hjorth", "Daniel Stisen"] });
  assert.equal(attach([m], [b]), 1);
  assert.deepEqual(m.score.sets, [[4, 6], [5, 3]]); // board's B (=match's A) first
  assert.deepEqual(m.score.points, ["30", "40"]);
});
ok("FLIPPED finished board: winner is the match's side, not the board's", () => {
  const m = mkMatch();
  const b = mkBoard({ state: "final", a: ["Emil Okkels", "William Søby"], b: ["Jakob Hjorth", "Daniel Stisen"], wonA: true });
  assert.equal(attach([m], [b]), 1);
  assert.equal(m.status, "final");
  assert.equal(m.score.winner, 1, "board side A won; that is the match's side B");
  assert.equal(m.score.points, undefined, "a finished match must not carry a live points cell");
});

console.log("\nattach() — guards");
ok("a match RankedIn already called final is never touched", () => {
  const m = mkMatch({ status: "final", score: { sets: [[6, 4], [7, 6]], winner: 0 } });
  assert.equal(attach([m], [mkBoard()]), 0);
  assert.deepEqual(m.score.sets, [[6, 4], [7, 6]]);
  assert.equal(m.raw, undefined);
});
ok("an upcoming board contributes nothing", () => {
  const m = mkMatch();
  assert.equal(attach([m], [mkBoard({ state: "upcoming", gamesA: [], gamesB: [] })]), 0);
  assert.equal(m.status, "upcoming");
});
ok("one board cannot be claimed by two matches", () => {
  const m1 = mkMatch({ id: "rankedin:1" }), m2 = mkMatch({ id: "rankedin:2" });
  assert.equal(attach([m1, m2], [mkBoard()]), 1);
  assert.equal(m2.status, "upcoming");
});
ok("ambiguous with no court to separate it: left alone, not guessed", () => {
  const m = mkMatch({ court: "" });
  const two = [mkBoard({ boardId: "B1", court: "" }), mkBoard({ boardId: "B2", court: "" })];
  assert.equal(attach([m], two), 0);
  assert.equal(m.status, "upcoming");
});
ok("ambiguous but the court corroborates one board", () => {
  const m = mkMatch({ court: "D2" });
  const two = [mkBoard({ boardId: "B1", court: "D1" }), mkBoard({ boardId: "B2", court: "D2", gamesA: [1], gamesB: [2] })];
  assert.equal(attach([m], two), 1);
  assert.deepEqual(m.score.sets, [[1, 2]]);
});
ok("a different pair does not match", () => {
  const m = mkMatch({ a: ["Lasse Hviid", "Jeppe Tolderlund"] });
  assert.equal(attach([m], [mkBoard()]), 0);
});
ok("estStart is cleared once a match is on court", () => {
  const m = mkMatch();
  attach([m], [mkBoard()]);
  assert.equal(m.estStart, null);
  assert.equal(m.estStartAt, null);
});

console.log("\nname join — Danish orthography and referee shorthand");
const joins = (a, b) => attach([mkMatch({ a, b: ["Emil Okkels", "William Søby"] })],
                               [mkBoard({ a: b, b: ["Emil Okkels", "William Søby"] })]) === 1;
ok("dropped trailing surname (the real 2026-09-12 case)", () =>
  assert.ok(joins(["Rasmus Pauli Aabling", "Wilfred Kjær Mikkelsen"], ["Rasmus Pauli", "Wilfred Kjær"])));
ok("ø / æ / å fold, both directions", () => {
  assert.ok(joins(["Marius Schjøtz", "Julius Fuglsang"], ["Marius Schjøtz", "Julius Fuglsang"]));
  assert.ok(joins(["Anna Kvarnström", "Nils Ångström"], ["Anna Kvarnstrom", "Nils Angstrom"]));
});
ok("abbreviated given name matches on the surname", () =>
  assert.ok(joins(["M. Vives", "A. Lund"], ["Martin Vives", "Anders Lund"])));
ok("seeding marker on the RankedIn side is stripped", () =>
  assert.ok(joins(["Jakob Hjorth (2)", "Daniel Stisen"], ["Jakob Hjorth", "Daniel Stisen"])));
ok("a shared FIRST name alone is not a person", () =>
  assert.ok(!joins(["Rasmus Aabling", "Wilfred Mikkelsen"], ["Rasmus", "Wilfred"])));
ok("different people who share a surname do not join", () =>
  assert.ok(!joins(["Kasper Pauli Aabling", "Cornelius Kjær Mikkelsen"], ["Rasmus Pauli", "Wilfred Kjær"])));

console.log(`\n${pass} assertions passed\n`);
