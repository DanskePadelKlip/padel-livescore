// GET /api/live-detail — read-only CORS relay for the two FIP live-detail feeds.
//
// The changeover stats overlay (public/overlay/stats.html) runs as an OBS Browser
// Source on a padelticker.com page. Both upstreams are cross-origin AND both 403
// without a browser User-Agent + a padelfip Referer, so the overlay cannot fetch
// them directly. This is the only thing standing between the two.
//
//   ?tid=397&day=29[&match=48327]   -> Sporteaser day payload (JSON)
//   ?event=FIP-2026-3507            -> Crionet `tournamentlive` board (HTML)
//
// ZERO WRITES. No KV, no D1. The site's KV write budget (~1k/day) is the binding
// cap and a 3 s poller would burn it before lunch. Everything this endpoint knows
// it re-reads from upstream; all accumulation lives client-side in the overlay.
//
// `max-age=2` plus a matching edge cacheTtl means N overlay instances (two stream
// boxes, a preview window, a phone) collapse onto ~one upstream fetch every 2 s.

import { FIP_HEADERS, SPORTEASER_HEADERS, liveBoardUrl, sporteaserDayUrl } from "../../src/live-detail.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};
// 2 s: shorter than the overlay's ~3 s poll, so a poll is never served a payload
// old enough to miss a point, but long enough for many instances to share one fetch.
const CACHE = "public, max-age=2";

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
  const event = u.get("event");

  try {
    if (tid) return await relaySporteaser(tid, u.get("day"), u.get("match"));
    if (event) return await relayCrionet(event);
  } catch (err) {
    // Upstream flakiness must not take the overlay down: it keeps its last good
    // state and retries on the next poll, so a 502 here is a transient blip.
    return json({ error: "upstream failed", detail: String(err && err.message) }, 502);
  }
  return json({ error: "need ?tid=<sporteaserTournamentId>&day=<dayOfMonth> or ?event=<FIP-YYYY-NNNN>" }, 400);
}

// ---- sporteaser (JSON) -----------------------------------------------------

async function relaySporteaser(tidRaw, dayRaw, matchRaw) {
  // Strict shapes only. These values are interpolated into an upstream URL, so
  // "digits, in range" is the whole allowlist — never pass anything else through.
  const tid = /^\d{1,9}$/.test(tidRaw) ? tidRaw : null;
  const day = /^\d{1,2}$/.test(dayRaw || "") && +dayRaw >= 1 && +dayRaw <= 31 ? String(+dayRaw) : null;
  if (!tid) return json({ error: "bad tid" }, 400);
  if (!day) return json({ error: "need day=<1..31> (day-of-month, not a play-day ordinal)" }, 400);

  const res = await fetch(sporteaserDayUrl(tid, day), {
    headers: SPORTEASER_HEADERS,
    cf: { cacheTtl: 2, cacheEverything: true },
  });
  if (!res.ok) return json({ error: `sporteaser HTTP ${res.status}` }, 502);
  const body = await res.json();

  // Optional single-match trim. A full day is ~500 KB across 30+ matches; an
  // overlay follows exactly one, and at a 3 s poll the difference is the whole
  // bandwidth story. The `days` array is kept either way — it is how the overlay
  // tells "wrong day" apart from "no matches".
  if (matchRaw && /^\d{1,12}$/.test(matchRaw)) {
    const hit = (body.matches || []).find((m) => String(m.id) === matchRaw) || null;
    return json({ days: body.days || [], matches: hit ? [hit] : [], filtered: matchRaw });
  }
  return json(body);
}

// ---- crionet live board (HTML) ---------------------------------------------

// Returned as raw HTML on purpose: parsing it needs a DOM, the edge has no
// linkedom, and the browser running the overlay has DOMParser for free.
async function relayCrionet(eventRaw) {
  if (!/^FIP-\d{4}-\d{1,6}$/.test(eventRaw)) return json({ error: "bad event id (expected FIP-YYYY-NNNN)" }, 400);
  const res = await fetch(liveBoardUrl(eventRaw), {
    headers: FIP_HEADERS,
    cf: { cacheTtl: 2, cacheEverything: true },
  });
  if (!res.ok) return json({ error: `crionet HTTP ${res.status}` }, 502);
  return new Response(await res.text(), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": CACHE, ...CORS },
  });
}
