// DPK board adapter — live scores from the boards people score on Danske Padel Klip's
// own streams (danskepadelklip.com/score2 vote rooms, /score, the control panel).
//
// WHY THIS EXISTS. A Danish league tie or a club day on MATCHi courts publishes nothing
// live anywhere: RankedIn carries a rubber only once its result is typed in (see the
// "Never LIVE" note in rankedin-teamleague.js), and no organiser runs RacketScore. But on
// a stream night the people at the court, or watching, score it on our board. This
// carries that score onto the match PadelTicker already lists.
//
// An ENRICHMENT, exactly like racketscore.js: never a source of matches. A board only
// ever updates a match that RankedIn (or another adapter) already gave us, and only while
// that match is not FINAL there. The moment the official result is typed in, the overlay
// stops and the official score is what shows. Nothing here is archived or written to D1.
//
// PROVISIONAL BY CONSTRUCTION. A crowd-scored board can put a point on the wrong side
// (it has: a DPF200 QF ended 10-7 on the board, 10-6 officially). Every match this
// touches carries raw.liveSource = "dpk-board" and raw.provisional = true, and the site
// labels it so.
//
// THE JOIN, strongest first:
//   1. tie + rubber from the vote room's lineup -> `rankedin-teamleague:<tie>:m<rubber>`.
//      vote.js and rankedin-teamleague.js both number rubbers by RankedIn's fixture order.
//   2. the board's own match id, when the control panel loaded it from this feed.
//   3. tie only -> names, but only among that tie's rubbers.
//   4. names across every pending match, racketscore's token-set rule, and only when the
//      answer is unique. Boards carry surnames ("Lang Jensen"), which that rule accepts.
// Whenever the match already has players, the names must agree with the board in one
// orientation or the other; an id join that contradicts the names is refused, not trusted.
//
// The feed is ONE request (danskepadelklip.com/api/boards), cached 15 s at the edge and
// polled here at most every MIN_MS. READ-ONLY.

import { STATUS } from "../schema.js";
import { sideMatches } from "./racketscore.js";

export const id = "dpk-board";

const FEED = process.env.DPK_BOARDS_URL || "https://danskepadelklip.com/api/boards";
const MIN_MS = 30_000;              // the feed is a Pages Function on a 100k/day budget
const STALE_MS = 3 * 60_000;        // keep serving the last answer through a blip, not longer
const REQ_TIMEOUT_MS = 8_000;
const NEAR_MS = 20 * 60 * 60_000;   // a board belongs to a match scheduled within this of now
const QUIET_HOURS = [1, 7];         // [from, to) Copenhagen: nobody streams, so do not poll

let last = { at: 0, okAt: 0, rooms: [] };

const copenhagenHour = () =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", hour: "2-digit", hour12: false }).format(new Date())) % 24;

/** The current boards, throttled. Never throws; an outage is [] once the last answer is stale. */
export async function fetchRooms(log = () => {}, { force = false } = {}) {
  const h = copenhagenHour();
  if (!force && h >= QUIET_HOURS[0] && h < QUIET_HOURS[1]) return [];
  const now = Date.now();
  if (!force && now - last.at < MIN_MS) return now - last.okAt < STALE_MS ? last.rooms : [];
  last.at = now;
  try {
    const res = await fetch(FEED, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    if (!doc || !Array.isArray(doc.rooms)) throw new Error("no rooms[] in the answer");
    last = { at: now, okAt: now, rooms: doc.rooms };
  } catch (err) {
    log(`    ! dpk-board: ${FEED} failed — ${err.message}`);
  }
  return now - last.okAt < STALE_MS ? last.rooms : [];
}

// ---- joining ----------------------------------------------------------------

const boardSides = (room) => (room.teams || []).map((names) => names.map((name) => ({ name })));

/** 0 = same orientation, 1 = flipped, null = the names say this is not that match. */
function orientation(m, room) {
  const mp = (m.teams || []).map((t) => (t && t.players) || []);
  const bp = boardSides(room);
  if (bp.length !== 2) return null;
  if (sideMatches(mp[0], bp[0]) && sideMatches(mp[1], bp[1])) return 0;
  if (sideMatches(mp[0], bp[1]) && sideMatches(mp[1], bp[0])) return 1;
  return null;
}
const hasPlayers = (m) => (m.teams || []).every((t) => t && t.players && t.players.length);

function near(m, now) {
  if (!m.startTime) return true;
  const t = Date.parse(m.startTime);
  return !Number.isFinite(t) || Math.abs(t - now) < NEAR_MS;
}

/** The pending matches a board may update: not final, not already carried by an official live source. */
function candidates(matches, now) {
  return matches.filter((m) =>
    m.status !== STATUS.FINAL &&
    !(m.raw && m.raw.liveSource && m.raw.liveSource !== id) &&
    near(m, now)
  );
}

function pickFor(room, pool, byId, log) {
  // 1 + 2: an id names the match; the names (when there are any) must not contradict it.
  const ids = [];
  if (room.tie && room.rubber) ids.push(`rankedin-teamleague:${room.tie}:m${room.rubber}`);
  if (room.matchId) ids.push(room.matchId);
  for (const mid of ids) {
    const m = byId.get(mid);
    if (!m) continue;
    if (!hasPlayers(m)) return { m, flip: 0, how: "id" };
    const o = orientation(m, room);
    if (o != null) return { m, flip: o, how: "id" };
    // A scorer can pick the wrong rubber number; the names then say which one it is.
    log(`    · dpk-board: ${room.room} names do not match ${mid}, id join refused`);
  }
  // 3 + 4: names, inside the tie when we know it, else everywhere; unique or nothing.
  const scope = room.tie ? pool.filter((m) => m.id.startsWith(`rankedin-teamleague:${room.tie}:m`)) : pool;
  const hits = [];
  for (const m of scope) {
    if (!hasPlayers(m)) continue;
    const o = orientation(m, room);
    if (o != null) hits.push({ m, flip: o, how: room.tie ? "tie+names" : "names" });
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) log(`    · dpk-board: ${room.room} matches ${hits.length} matches, left alone`);
  return null;
}

const swap = (pair, flip) => (flip ? [pair[1], pair[0]] : [pair[0], pair[1]]);

/** A COPY of `m` carrying the board's score. Adapters cache their matches; never mutate them. */
function overlay(m, room, flip, how) {
  const out = structuredClone(m);
  const sets = (room.sets || []).map((s) => swap(s, flip));
  out.score = { ...(out.score || {}), sets };
  if (room.finished) {
    out.status = STATUS.FINAL;
    out.score.winner = room.winner === 0 || room.winner === 1 ? (flip ? 1 - room.winner : room.winner) : null;
    delete out.score.points;
    delete out.score.serving;
  } else {
    out.status = STATUS.LIVE;
    out.score.winner = null;
    if (Array.isArray(room.points) && room.points.length === 2) out.score.points = swap(room.points.map(String), flip);
    else delete out.score.points;
    if (room.serving === 0 || room.serving === 1) out.score.serving = flip ? 1 - room.serving : room.serving;
  }
  out.estStart = null;
  out.estStartAt = null;
  if (!out.court && room.court) out.court = room.court;
  out.raw = { ...(out.raw || {}), liveSource: id, provisional: true, dpkRoom: room.room, dpkScoredBy: room.source === "vote" ? "crowd" : "board", dpkJoin: how };
  return out;
}

/**
 * Overlay the boards onto `matches`. Returns the enriched COPIES (the caller swaps them in
 * by id); `matches` itself is never modified. A board is used for one match at most.
 */
export function attach(matches, rooms, log = () => {}, now = Date.now()) {
  const usable = (rooms || []).filter((r) => r && (r.live || r.finished) && Array.isArray(r.teams) && r.teams.length === 2);
  if (!usable.length) return [];
  const pool = candidates(matches, now);
  if (!pool.length) return [];
  const byId = new Map(pool.map((m) => [m.id, m]));
  // Live boards first: what is on court now beats a board still showing a finished match.
  const ordered = [...usable].sort((a, b) => (a.live ? 0 : 1) - (b.live ? 0 : 1));
  const taken = new Set();
  const out = [];
  for (const room of ordered) {
    const hit = pickFor(room, pool.filter((m) => !taken.has(m.id)), byId, log);
    if (!hit || taken.has(hit.m.id)) continue;
    taken.add(hit.m.id);
    out.push(overlay(hit.m, room, hit.flip, hit.how));
  }
  return out;
}

/** Fetch + attach. Never throws: a DPK outage leaves every match exactly as it was. */
export async function applyLiveDetail(matches, log = () => {}, opts = {}) {
  try {
    const rooms = await fetchRooms(log, opts);
    if (!rooms.length) return [];
    const out = attach(matches, rooms, log);
    const live = rooms.filter((r) => r.live).length;
    log(`  DPK boards: ${rooms.length} board(s) (${live} live) — ${out.length} match(es) carried`);
    return out;
  } catch (err) {
    log(`    ! dpk-board overlay failed — ${err.message}`);
    return [];
  }
}
