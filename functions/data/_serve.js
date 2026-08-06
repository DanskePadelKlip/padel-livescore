// Serve a /data/*.json blob: KV-first (written by the scheduled worker — see
// worker/index.js), falling back to the static asset baked into the deployment
// (produced by scripts/fetch-live.js in CI, or committed, depending on the file).
// This is what decouples DATA freshness from CODE deploys: the worker updates KV
// every cycle and nothing needs to be redeployed.
//
// Consumers all already fetch these exact paths (public/app.js, the SSR
// functions, /api/health), so they get the fresh copy with zero changes.
//
// KV reads use cacheTtl 60 (the minimum): with the worker's fastest cadence also
// 60s, worst-case staleness is ~2 min — versus hours on the Actions cron.

export async function serveBlob({ request, env }, key, { emptyFallback = null } = {}) {
  if (env.LIVE) {
    try {
      const blob = await env.LIVE.get(key, { type: "text", cacheTtl: 60 });
      if (blob) {
        return new Response(blob, {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-padelticker-source": "kv",
          },
        });
      }
    } catch {
      // fall through to the static asset
    }
  }
  const asset = await env.ASSETS.fetch(request);
  // A missing asset doesn't 404 here: the project's SPA fallback serves
  // index.html (200, text/html) for unknown paths. Only trust a real JSON body.
  if (asset.ok && (asset.headers.get("content-type") || "").includes("json")) return asset;
  // No KV yet and no baked asset (e.g. a deploy that skipped the fetch step):
  // an empty-but-valid shape beats an HTML shell the UI would fail to parse.
  return new Response(JSON.stringify(emptyFallback ?? { error: "no data yet" }), {
    status: emptyFallback ? 200 : 404,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
