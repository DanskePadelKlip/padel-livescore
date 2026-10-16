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

//
// WATCH LINKS. Our court streams are on the Danske Padel Klip YouTube channel. Which
// broadcast is on air for which court only YouTube knows (a stream key carries several
// broadcasts, and the configs have been wrong on the night), so the answer comes from
// matchi-autostream's bin/live-courts.mjs, run on this machine: it asks YouTube for the
// broadcasts that are live and joins each to a MATCHi court (and the tie when the stream
// schedule has it). A board room `court-<courtId>` then gets raw.watchUrl, and every
// pending match of a streamed tie gets raw.tieWatch = [{ court, url }]. Where that script
// is absent (GitHub Actions, any other box) there are simply no links.

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// ---- which court is on air, from YouTube --------------------------------------------

const LIVE_COURTS_SCRIPT = process.env.DPK_LIVE_COURTS_SCRIPT
  || resolve(dirname(fileURLToPath(import.meta.url)), "../../../matchi-autostream/bin/live-courts.mjs");
const COURTS_MIN_MS = 90_000;       // one YouTube API unit per run
const COURTS_STALE_MS = 5 * 60_000;
const COURTS_TIMEOUT_MS = 60_000;
const TIE_WINDOW_MS = [5 * 60 * 60_000, 60 * 60_000];   // a tie may be on court from 1 h before to 5 h after its start

let courts = { at: 0, okAt: 0, list: [], running: false };

/**
 * The courts on air, from the last run of live-courts.mjs. Never blocks the cycle: a due run
 * starts in the background and the NEXT cycle sees its answer. `runner` is for the tests.
 */
export function liveCourts(log = () => {}, { runner = runLiveCourts, now = Date.now() } = {}) {
  if (!courts.running && now - courts.at >= COURTS_MIN_MS) {
    courts.at = now;
    courts.running = true;
    Promise.resolve().then(runner).then((doc) => {
      if (!doc || !Array.isArray(doc.courts)) throw new Error("no courts[] in the answer");
      courts.list = doc.courts.filter((c) => c && c.courtId && /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{6,20}$/.test(c.url || ""));
      courts.okAt = Date.now();
    }).catch((err) => log(`    ! dpk-board: live courts failed — ${err.message}`))
      .finally(() => { courts.running = false; });
  }
  return now - courts.okAt < COURTS_STALE_MS ? courts.list : [];
}
export const _resetLiveCourts = () => { courts = { at: 0, okAt: 0, list: [], running: false }; };

function runLiveCourts() {
  if (!existsSync(LIVE_COURTS_SCRIPT)) return null;
  return new Promise((ok, fail) => {
    execFile(process.execPath, [LIVE_COURTS_SCRIPT], { cwd: dirname(dirname(LIVE_COURTS_SCRIPT)), timeout: COURTS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) return fail(new Error(String(stderr || err.message).trim().slice(0, 200)));
        try { ok(JSON.parse(stdout)); } catch (e) { fail(new Error("unreadable answer")); }
      });
  });
}

/** Worth asking YouTube: a board is up, or a Danish tie is within its window right now. */
function streamsLikely(matches, rooms, now) {
  if ((rooms || []).some((r) => /^court-\d+$/.test(r && r.room))) return true;
  return matches.some((m) => {
    if (!m.raw || !m.raw.tie || m.status === STATUS.FINAL) return false;
    const t = Date.parse(m.startTime);
    return Number.isFinite(t) && now >= t - TIE_WINDOW_MS[1] && now <= t + TIE_WINDOW_MS[0];
  });
}

const courtIdOf = (room) => { const m = /^court-(\d+)$/.exec(String(room || "")); return m ? m[1] : null; };
const tieOfId = (mid) => { const m = /^rankedin-teamleague:(\d+)(?::m\d+)?$/.exec(String(mid || "")); return m ? Number(m[1]) : null; };

/**
 * Watch links onto `byId` (match id -> match, copies already made where overlaid). Returns the
 * ids it changed; every change is made on a copy, never on an adapter's cached object.
 */
export function attachWatch(byId, overlaid, live) {
  const changed = new Set();
  if (!live || !live.length) return changed;
  const byCourt = new Map(live.map((c) => [String(c.courtId), c]));
  const copy = (id) => {
    if (!overlaid.has(id) && !changed.has(id)) byId.set(id, structuredClone(byId.get(id)));
    changed.add(id);
    return byId.get(id);
  };
  // A board on a streamed court: that match IS on that broadcast.
  for (const id of overlaid) {
    const m = byId.get(id);
    const c = m && m.status !== STATUS.FINAL && byCourt.get(courtIdOf(m.raw && m.raw.dpkRoom));
    if (!c) continue;
    const out = copy(id);
    out.raw = { ...out.raw, watchUrl: c.url, watchCourt: c.court || null };
  }
  // A streamed tie: every pending match of it lists the tie's courts.
  const byTie = new Map();
  for (const c of live) if (c.tie) (byTie.get(c.tie) || byTie.set(c.tie, []).get(c.tie)).push({ court: c.court || null, url: c.url });
  if (!byTie.size) return changed;
  for (const [id, m] of byId) {
    const list = byTie.get(tieOfId(id));
    if (!list || m.status === STATUS.FINAL) continue;
    const out = copy(id);
    out.raw = { ...(out.raw || {}), tieWatch: [...list].sort((a, b) => String(a.court).localeCompare(String(b.court), "en", { numeric: true })) };
  }
  return changed;
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
    const out = rooms.length ? attach(matches, rooms, log) : [];
    if (rooms.length) {
      const live = rooms.filter((r) => r.live).length;
      log(`  DPK boards: ${rooms.length} board(s) (${live} live) — ${out.length} match(es) carried`);
    }
    const now = Date.now();
    const h = copenhagenHour();
    if (h >= QUIET_HOURS[0] && h < QUIET_HOURS[1]) return out;
    if (!streamsLikely(matches, rooms, now)) return out;
    const live = liveCourts(log, { now });
    if (!live.length) return out;
    const byId = new Map(matches.map((m) => [m.id, m]));
    for (const m of out) byId.set(m.id, m);
    const changed = attachWatch(byId, new Set(out.map((m) => m.id)), live);
    const ids = new Set([...out.map((m) => m.id), ...changed]);
    log(`  DPK streams: ${live.length} court(s) on air — ${changed.size} match(es) linked`);
    return [...ids].map((id) => byId.get(id));
  } catch (err) {
    log(`    ! dpk-board overlay failed — ${err.message}`);
    return [];
  }
}
