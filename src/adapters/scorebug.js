// Organiser scorebug overlay - point-level live detail for the broadcast court.
//
// Some organisers embed their OWN broadcast scorebug in padelfip.com's Live Score tab
// instead of Crionet's live board. FIP Gold Bucharest 2026 does:
// https://scorebug.fipgoldbucharest.com/overlay - a referee app that pushes the whole
// match state over a WebSocket and also serves it as JSON at GET /api/state. It covers
// ONE match (the broadcast court) but at point level, while Crionet's board for the same
// event carries set games only and reports the current game as "0" all match long, and
// lags the scorebug on games too (verified 2026-09-11: Crionet 5-7 0-0 "0-0" while the
// scorebug read 5-7 1-0 40-0).
//
// READ-ONLY. This module only ever GETs /api/state. The same kit accepts
// POST /api/command from referee devices - never call it.

import { STATUS } from "../schema.js";

export const id = "scorebug";

// Bounded on purpose, like every adapter fetch (see src/http.js): a hung request must
// not stall the refresh cycle.
const REQ_TIMEOUT_MS = 10_000;
const AJAX = "https://www.padelfip.com/wp-admin/admin-ajax.php";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Referer: "https://www.padelfip.com/",
  Accept: "application/json, text/html",
};

// Discovery is two padelfip fetches per event, so it is cached per process like
// sporteaser's. A hit holds for the tournament; a miss is re-checked sooner because an
// organiser can switch the tab on partway through an event.
const HIT_TTL = 6 * 60 * 60_000;
const MISS_TTL = 30 * 60_000;
const baseCache = new Map(); // eventLink -> { base, at }

/**
 * The scorebug origin embedded in an event's Live Score tab, e.g.
 * "https://scorebug.fipgoldbucharest.com", or null when the tab holds something else
 * (Crionet, Sporteaser) or nothing.
 */
export async function discoverBase(eventLink, log = () => {}) {
  const hit = baseCache.get(eventLink);
  if (hit && Date.now() - hit.at < (hit.base ? HIT_TTL : MISS_TTL)) return hit.base;

  let base = null;
  try {
    const html = await (await fetch(eventLink, { headers: HEADERS, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) })).text();
    const postId = (html.match(/postid-(\d+)/) || html.match(/data-post-id="(\d+)"/) || [])[1];
    const nonce = (html.match(/padelfip_ajax\s*=\s*\{[^}]*"nonce":"([a-f0-9]+)"/) || [])[1];
    if (!postId || !nonce) throw new Error("no postid/nonce on event page");

    const res = await fetch(AJAX, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
      body: new URLSearchParams({ action: "livescore_tab_load", security: nonce, post_id: postId }),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    const frame = String((await res.json())?.data?.html || "");
    // The iframe is lazy: its URL sits in data-src, which this also matches.
    const m = frame.match(/src="(https:\/\/[^"/]+)\/overlay\b/);
    if (m && !/matchscorerlive|sporteaser/i.test(m[1])) base = m[1];
  } catch (err) {
    log(`    · scorebug discovery skipped for ${eventLink} - ${err.message}`);
  }
  baseCache.set(eventLink, { base, at: Date.now() });
  return base;
}

/** The scorebug's current match state, or null. */
export async function fetchState(base, log = () => {}) {
  try {
    const res = await fetch(`${base}/api/state`, {
      headers: { ...HEADERS, Accept: "application/json" },
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const s = await res.json();
    return s && Array.isArray(s.teams) && s.teams.length === 2 && Array.isArray(s.points) ? s : null;
  } catch (err) {
    log(`    · scorebug ${base} skipped - ${err.message}`);
    return null;
  }
}

// Letters-only tokens, accents folded and seed/entry marks like "(2)" or "(LL)" dropped.
// Single letters go too, so FIP's "M." initials never count as evidence.
const tokens = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 1);

// The scorebug stores bare surnames ("Espino", "Lijó"); FIP writes "B. Espino Mustafa",
// "P. Lijo". A side matches when each scorebug name is contained in a DIFFERENT FIP
// player's name, in either order within the pair.
function sideMatches(fipPlayers, sbPlayers) {
  const fip = (fipPlayers || []).map((p) => new Set(tokens(p.name)));
  const sb = (sbPlayers || []).map((p) => tokens(p.name));
  if (fip.length !== 2 || sb.length !== 2 || !sb[0].length || !sb[1].length) return false;
  const inside = (i, j) => sb[i].every((t) => fip[j].has(t));
  return (inside(0, 0) && inside(1, 1)) || (inside(0, 1) && inside(1, 0));
}

const LADDER = ["0", "15", "30", "40"];

/** Current game as display strings, in the scorebug's side order. */
export function pointLabels(state) {
  const p = (state.points || []).map((x) => Number(x) || 0);
  if (p.length !== 2) return null;
  if (state.inTiebreak || state.inSuperTiebreak) return [String(p[0]), String(p[1])];
  if (p[0] >= 3 && p[1] >= 3) {
    // Deuce (including the star point) shows 40-40; advantage shows AD-40.
    if (p[0] === p[1] + 1) return ["AD", "40"];
    if (p[1] === p[0] + 1) return ["40", "AD"];
    return ["40", "40"];
  }
  return [LADDER[Math.min(p[0], 3)], LADDER[Math.min(p[1], 3)]];
}

const totalGames = (sets) =>
  (sets || []).reduce((n, s) => n + (parseInt(s[0], 10) || 0) + (parseInt(s[1], 10) || 0), 0);

/**
 * Overlay the scorebug onto the one live match it describes. Returns 1 when attached.
 * Nothing is touched unless exactly one live match has both pairs matching.
 */
export function attach(matches, state, log = () => {}) {
  if (!state || state.status !== "live") return 0;
  const sb = state.teams.map((t) => t.players || []);
  const hits = [];
  for (const m of matches) {
    if (m.status !== STATUS.LIVE) continue;
    const f = m.teams.map((t) => t.players || []);
    if (sideMatches(f[0], sb[0]) && sideMatches(f[1], sb[1])) hits.push({ m, flipped: false });
    else if (sideMatches(f[0], sb[1]) && sideMatches(f[1], sb[0])) hits.push({ m, flipped: true });
  }
  if (hits.length !== 1) {
    if (hits.length > 1) log(`    · scorebug matched ${hits.length} live matches - ambiguous, skipped`);
    return 0;
  }
  const { m, flipped } = hits[0];
  const side = (pair) => (flipped ? [pair[1], pair[0]] : pair);

  const pts = pointLabels(state);
  if (pts) m.score.points = side(pts);
  if (state.server === 0 || state.server === 1) m.score.serving = flipped ? 1 - state.server : state.server;
  delete m.score.warmup;

  // Completed sets plus the set in progress. Taken only when the scorebug is at least
  // as far into the match as Crionet (it normally leads), so a stale scorebug can never
  // roll a score backwards.
  const games = state.games || [0, 0];
  const sets = [
    ...(state.sets || []).map((s) => [String(s.a), String(s.b)]),
    [String(games[0] ?? 0), String(games[1] ?? 0)],
  ].map(side);
  if (totalGames(sets) >= totalGames(m.score.sets)) m.score.sets = sets;

  m.raw = { ...(m.raw || {}), scorebug: state.seq ?? true };
  return 1;
}
