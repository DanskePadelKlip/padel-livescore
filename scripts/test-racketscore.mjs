// Unit tests for the paths live data does not reliably exercise: flipped orientation,
// the finished-board path, the guards, and the Danish name fold.
import assert from "node:assert/strict";
import { attach } from "../src/adapters/racketscore.js";

const okAsync = async (name, fn) => { await fn(); pass++; console.log("  ok  " + name); };

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

console.log("\ndiscovery — a failed events fetch must not pin an empty list");

// The events list is a slow 3 MB document. Before 2026-09-27 a failure stamped a fresh
// 30-minute TTL over whatever was cached, so ONE timeout on a cold process blinded the
// overlay for half an hour — which is how the Swedish championship semi-finals sat on
// padelticker with a blank board while RacketScore was publishing them point by point.
// A failure may back off briefly; it may never buy the full TTL.
const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const freshModule = (tag) => import(`../src/adapters/racketscore.js?t=${tag}`);
const eventsBody = (slug) => [{
  slug, sport: "padel", is_test: false,
  start: new Date(Date.now() - 864e5).toISOString(),
  end: new Date(Date.now() + 864e5).toISOString(),
}];

// Advance the module's clock instead of sleeping. 61 s is far past any sane retry
// floor and far short of the 30-minute TTL, so this asserts the invariant that matters
// — a failure does not buy the full TTL — without pinning the exact backoff value.
const atPlus = async (ms, fn) => {
  const real = Date.now;
  Date.now = () => real.call(Date) + ms;
  try { return await fn(); } finally { Date.now = real; }
};

await okAsync("a failed discovery does not buy the full TTL", async () => {
  const mod = await freshModule("fail-then-ok");
  let calls = 0;
  const slugs = await withFetch(async () => { calls++; throw new Error("timeout"); },
    () => mod.discoverCurrentSlugs());
  assert.deepEqual(slugs, [], "a first-failure process has nothing to serve");
  assert.equal(calls, 1);
  const second = await atPlus(61_000, () => withFetch(
    async () => ({ ok: true, json: async () => eventsBody("sm-2026") }),
    () => mod.discoverCurrentSlugs()));
  assert.deepEqual(second, ["sm-2026"], "the retry reached the origin and found the event");
});

await okAsync("a successful discovery is cached, not refetched every cycle", async () => {
  const mod = await freshModule("cache-hit");
  let calls = 0;
  const hit = async () => { calls++; return { ok: true, json: async () => eventsBody("sm-2026") }; };
  assert.deepEqual(await withFetch(hit, () => mod.discoverCurrentSlugs()), ["sm-2026"]);
  assert.deepEqual(await withFetch(hit, () => mod.discoverCurrentSlugs()), ["sm-2026"]);
  assert.equal(calls, 1, "the second call came from cache");
});

await okAsync("a failure keeps the last-good slugs rather than going blind", async () => {
  const mod = await freshModule("keep-last-good");
  await withFetch(async () => ({ ok: true, json: async () => eventsBody("sm-2026") }),
    () => mod.discoverCurrentSlugs());
  // Expire the cache, then fail: the previous list must survive.
  const kept = await atPlus(31 * 60_000, () => withFetch(
    async () => { throw new Error("timeout"); },
    () => mod.discoverCurrentSlugs()));
  assert.deepEqual(kept, ["sm-2026"]);
});

console.log(`\n${pass} assertions passed\n`);
