// GET /api/live-rows — the qualifier sheet, parsed, per request.
//
// data/matches.json reaches a board only after a full Pages deploy: the daemon
// scrapes FIP, rebuilds the file and deploys, and the deploy alone is ~20 s.
// Measured against FIP mid-match on 22 Sep that left a scoreboard 25-60 s behind
// the court, which is visible on a restream.
//
// This is the same trick /api/live-detail plays for the stats overlay: read
// upstream on the request, behind a short edge cache, with no deploy in the
// path. It calls the adapter's own eventRows(), so the ids, statuses and score
// shapes are identical to the ones in matches.json - a board can switch between
// the two without knowing which it is reading.
//
//   /api/live-rows                -> every event currently inside its dates
//   /api/live-rows?tid=2309       -> just that one
//
// ZERO WRITES: no KV, no D1, nothing accumulated here. Deliberately separate
// from live-detail.js so that endpoint keeps serving the stats overlay
// untouched while this one changes.
import { EVENTS, eventRows } from "../../src/adapters/puntuate.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};
// 3 s: under a board's poll, so a poll is never handed a payload old enough to
// have missed a point, and long enough that several boards (two stream boxes, a
// preview, a phone) collapse onto roughly one upstream read.
const CACHE = "public, max-age=3";

const json = (d, status = 200) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": CACHE, ...CORS },
  });

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

// Only GET and OPTIONS are exported, so Pages answers every other method with a
// 405 of its own: this endpoint must never be usable as a write path.
export async function onRequestGet({ request }) {
  const u = new URL(request.url).searchParams;
  const tid = u.get("tid");
  const today = new Date().toISOString().slice(0, 10);

  let events = EVENTS.filter((ev) => (!ev.from || today >= ev.from) && (!ev.to || today <= ev.to));
  if (tid) events = EVENTS.filter((ev) => ev.tid === tid);   // an explicit id overrides the dates
  if (!events.length) return json({ generatedAt: new Date().toISOString(), count: 0, matches: [] });

  try {
    // Standings come from a second host and a scoreboard never reads them, so
    // they stay out: this path is judged on latency.
    const rows = await Promise.all(
      events.map((ev) => eventRows(ev, { withStandings: false })),
    );
    const matches = rows.flat();
    return json({ generatedAt: new Date().toISOString(), count: matches.length, matches });
  } catch (err) {
    // A board holds its last good render, so an error here costs a poll, not the
    // graphic. Say what failed rather than serving an empty list, which a board
    // would read as "the match is gone".
    return json({ error: String(err && err.message ? err.message : err) }, 502);
  }
}
