// Offline tests for src/adapters/dpk-board.js — the join of our own stream boards onto
// PadelTicker's matches. No network: attach() is pure, and fetchRooms() is exercised
// against a stubbed fetch.
//   node scripts/test-dpk-board.mjs

import { attach, fetchRooms } from "../src/adapters/dpk-board.js";
import { STATUS } from "../src/schema.js";

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log("  FAIL  " + name); } };
const eq = (a, b, name) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) pass++; else { fail++; console.log(`  FAIL  ${name}\n        got  ${A}\n        want ${B}`); }
};

const NOW = Date.UTC(2026, 9, 15, 18, 0, 0);
const team = (...names) => ({ name: names.join(" / "), players: names.map((name) => ({ name, country: "DK" })) });
const match = (id, a, b, extra = {}) => ({
  id, source: id.split(":")[0], federation: "DK", tournament: { id: 1, name: "T", url: "" },
  className: null, round: null, court: null, status: STATUS.UPCOMING,
  startTime: new Date(NOW - 30 * 60_000).toISOString(), teams: [a, b], score: { sets: [], winner: null }, ...extra,
});
const room = (o) => ({ room: "court-1", source: "vote", live: true, finished: false, winner: null, sets: [[2, 1]], points: ["30", "15"],
  serving: 0, teams: [["Lang Jensen", "Holm"], ["Ry", "Ask"]], court: "Bane 3", matchId: null, tie: null, rubber: null, ...o });

const rubber = match("rankedin-teamleague:152468:m2", team("Anders Lang Jensen", "Bo Holm"), team("Carl Ry", "Dan Ask"));
const other = match("rankedin-teamleague:152468:m3", team("Erik Berg", "Finn Dal"), team("Gert Lund", "Hans Vig"));
const dpf = match("rankedin:777", team("Mads Lund", "Ole Berg"), team("Per Dal", "Kim Vang"));

console.log("exact join: tie + rubber");
{
  const before = JSON.stringify(rubber);
  const out = attach([rubber, other, dpf], [room({ tie: 152468, rubber: 2 })], () => {}, NOW);
  eq(out.length, 1, "one match carried");
  const m = out[0];
  eq([m.id, m.status, m.score.sets, m.score.points, m.score.serving], [rubber.id, STATUS.LIVE, [[2, 1]], ["30", "15"], 0], "live score lands on m2");
  eq([m.raw.liveSource, m.raw.provisional, m.raw.dpkScoredBy, m.raw.dpkJoin, m.court], ["dpk-board", true, "crowd", "id", "Bane 3"], "marked provisional, crowd-scored, court filled");
  eq(JSON.stringify(rubber), before, "the adapter's own (cached) match object is untouched");
}

console.log("orientation");
{
  const flipped = room({ tie: 152468, rubber: 2, teams: [["Ry", "Ask"], ["Lang Jensen", "Holm"]], sets: [[6, 4], [1, 3]], points: ["40", "Ad"], serving: 1 });
  const m = attach([rubber], [flipped], () => {}, NOW)[0];
  eq([m.score.sets, m.score.points, m.score.serving], [[[4, 6], [3, 1]], ["Ad", "40"], 0], "board sides swapped onto the match's sides");
}

console.log("an id that contradicts the names is refused");
{
  const wrong = room({ tie: 152468, rubber: 3 });   // our names are rubber 2's
  const out = attach([rubber, other], [wrong], () => {}, NOW);
  eq(out.map((m) => m.id), [rubber.id], "not m3 by id; found m2 by names inside the tie");
  eq(out[0].raw.dpkJoin, "tie+names", "and says how");
}

console.log("matchId from the control panel");
{
  const out = attach([dpf], [room({ matchId: "rankedin:777", teams: [["Lund", "Berg"], ["Dal", "Vang"]], source: "board" })], () => {}, NOW);
  eq([out.length, out[0] && out[0].raw.dpkScoredBy], [1, "board"], "joined by the board's own match id");
}

console.log("names only");
{
  const r = room({ teams: [["Lund", "Berg"], ["Dal", "Vang"]] });
  eq(attach([rubber, dpf], [r], () => {}, NOW).map((m) => m.id), ["rankedin:777"], "unique surname match");
  const twin = match("rankedin:778", team("Mads Lund", "Ole Berg"), team("Per Dal", "Kim Vang"));
  const logs = [];
  eq(attach([dpf, twin], [r], (s) => logs.push(s), NOW).length, 0, "two matches fit: left alone");
  ok(logs.some((s) => /left alone/.test(s)), "and the ambiguity is logged");
  eq(attach([dpf], [room({ teams: [["Lund"], ["Dal", "Vang"]] })], () => {}, NOW).length, 0, "a half-named side does not match a full pair");
}

console.log("the official result wins");
{
  const done = { ...rubber, status: STATUS.FINAL, score: { sets: [[6, 3], [6, 2]], winner: 0 } };
  eq(attach([done], [room({ tie: 152468, rubber: 2 })], () => {}, NOW).length, 0, "a FINAL match is never overlaid");
  const rs = { ...dpf, status: STATUS.LIVE, raw: { liveSource: "racketscore" } };
  eq(attach([rs], [room({ matchId: "rankedin:777", teams: [["Lund", "Berg"], ["Dal", "Vang"]] })], () => {}, NOW).length, 0, "an official live source (RacketScore) is not overridden");
}

console.log("finished board");
{
  const m = attach([rubber], [room({ tie: 152468, rubber: 2, live: false, finished: true, winner: 1, sets: [[6, 4], [3, 6], [8, 10]], points: null })], () => {}, NOW)[0];
  eq([m.status, m.score.winner, m.score.sets, "points" in m.score], [STATUS.FINAL, 1, [[6, 4], [3, 6], [8, 10]], false], "provisional final with the board's winner");
}

console.log("guards");
{
  eq(attach([rubber], [room({ tie: 152468, rubber: 2, live: false, finished: false })], () => {}, NOW).length, 0, "a 0-0 board (names only) changes nothing");
  const old = { ...rubber, startTime: new Date(NOW - 26 * 3600_000).toISOString() };
  eq(attach([old], [room({ tie: 152468, rubber: 2 })], () => {}, NOW).length, 0, "a match from yesterday is not today's board");
  const out = attach([rubber, dpf], [room({ tie: 152468, rubber: 2 }), room({ room: "court-9", tie: 152468, rubber: 2, live: false, finished: true, winner: 0, sets: [[6, 0], [6, 0]] })], () => {}, NOW);
  eq([out.length, out[0].status], [1, STATUS.LIVE], "two boards on one match: the live one wins, once");
}

console.log("fetchRooms");
{
  let calls = 0, mode = "ok";
  globalThis.fetch = async () => {
    calls++;
    if (mode === "down") throw new Error("offline");
    return new Response(JSON.stringify({ at: "x", rooms: [room({})] }));
  };
  const r1 = await fetchRooms(() => {}, { force: true });
  eq([calls, r1.length], [1, 1], "one request");
  mode = "down";
  const logs = [];
  const r2 = await fetchRooms((s) => logs.push(s), { force: true });
  eq([calls, r2.length], [2, 1], "a failed poll keeps serving the last good answer");
  ok(logs.some((s) => /failed/.test(s)), "and logs the failure");
  globalThis.fetch = async () => new Response("<html>", { status: 200 });
  eq((await fetchRooms(() => {}, { force: true })).length, 1, "garbage is a failure, not an empty board list");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
