// Serve a /data/*.json blob from whichever producer has the FRESHER copy:
//   · the static asset baked into the Pages deployment — written by the laptop
//     daemon (scripts/refresh-loop.js, the PRIMARY producer) or CI fetch runs
//   · the D1 `live_blobs` row — written by the fallback worker (worker/index.js)
//     while the daemon is quiet
// Freshest wins per request, so producer handoff needs no coordination: the
// daemon deploys → its static file is newest → served; the laptop sleeps → the
// worker's D1 rows age past it → served; and so on.
//
// A 25s per-colo Cache API entry (keyed WITHOUT the query string — the UI
// cache-busts with ?_=) keeps D1 reads and asset fetches off the hot path.
// Consumers all already fetch these exact paths (public/app.js, the SSR
// functions, /api/health), so they pick this logic up with zero changes.

const CACHE_S = 25;

// generatedAt (matches/rankings/calendar) / generated_at (health) sit in the
// first bytes of every payload both producers write — sniff, don't parse 300 KB.
const stampOf = (body) => {
  const m = (body || "").slice(0, 400).match(/"generated_?[aA]t"\s*:\s*"([^"]+)"/);
  return m ? Date.parse(m[1]) || 0 : 0;
};

export async function serveBlob({ request, env, waitUntil }, key, { emptyFallback = null, d1First = false } = {}) {
  const url = new URL(request.url);
  const cacheKey = new Request(url.origin + url.pathname); // query stripped
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return withClientHeaders(hit);

  let d1Body = null;
  try {
    d1Body = (await env.DB.prepare("SELECT body FROM live_blobs WHERE key = ?").bind(key).first())?.body ?? null;
  } catch {
    // table not created yet (worker never ran) or D1 hiccup — static still works
  }

  let assetBody = null;
  const asset = await env.ASSETS.fetch(request);
  // A missing asset doesn't 404 here: the project's SPA fallback serves
  // index.html (200, text/html) for unknown paths. Only trust a real JSON body.
  if (asset.ok && (asset.headers.get("content-type") || "").includes("json")) assetBody = await asset.text();

  const body = d1First
    ? d1Body ?? assetBody // for payloads without a timestamp (rankings-base)
    : stampOf(d1Body) >= stampOf(assetBody) ? d1Body ?? assetBody : assetBody;

  const res = new Response(body ?? JSON.stringify(emptyFallback ?? { error: "no data yet" }), {
    status: body || emptyFallback ? 200 : 404,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_S}`,
      "x-padelticker-source": body ? (body === assetBody ? "static" : "d1") : "none",
    },
  });
  if (res.status === 200) waitUntil(cache.put(cacheKey, res.clone()));
  return withClientHeaders(res);
}

// The colo cache honours max-age above; browsers shouldn't (the UI polls with
// its own cache-busting, and stale-while-shared caching confuses debugging).
function withClientHeaders(res) {
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "no-store");
  // Pages adds this to STATIC assets by itself; a Function-built Response does
  // not, so routing /data/*.json through here silently broke the only
  // cross-origin consumer (danskepadelklip.com's scoreboard control panel).
  // Set on this path, not in the constructor: it also covers the colo-cache hit.
  out.headers.set("access-control-allow-origin", "*");
  return out;
}
