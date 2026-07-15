// GET /api/health — machine-readable health for the Control Tower + edge watchdog.
// Reads the pipeline's health.json (raw facts written each refresh) and derives a
// verdict, INCLUDING a live freshness check: if the refresh job dies, generated_at
// goes stale and this reports "down" even though the last data still says ok — the
// dead-man's switch. Shape ({overall, checks:[{status:"PASS"|"FAIL"}]}) matches
// what control-tower/build_status.ps1 Ping() expects.
const FRESH_MIN = 60; // refresh runs every 15 min; >60 (GH-cron jitter margin) = stale

const json = (d, status = 200) =>
  new Response(JSON.stringify(d, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" },
  });

export async function onRequestGet({ request }) {
  const origin = new URL(request.url).origin;
  const checks = [];
  const add = (name, title, ok, detail) => checks.push({ name, title, status: ok ? "PASS" : "FAIL", detail });

  let h = null;
  try {
    // Bound this self-subrequest: if /data/health.json can't be served the fetch
    // stalls and the Function never responds, so the monitor sees a raw timeout
    // instead of the intended fast overall:"down". A 3s abort drops into catch {}.
    const r = await fetch(origin + "/data/health.json?_=" + Date.now(), { cf: { cacheTtl: 0 }, signal: AbortSignal.timeout(3000) });
    if (r.ok) h = await r.json();
  } catch {}

  if (!h || !h.generated_at) {
    add("data", "Data feed", false, "health.json missing — pipeline never wrote a snapshot");
    return json({ overall: "down", generated_at: null, checks });
  }

  const ageMin = (Date.now() - Date.parse(h.generated_at)) / 60000;
  add("fresh", "Data freshness", ageMin <= FRESH_MIN, `last update ${ageMin.toFixed(0)} min ago`);   // critical
  add("volume", "Match volume", (h.total || 0) > 0, `${h.total || 0} matches`);                       // critical
  for (const s of h.sources || []) {                                                                  // per-adapter (warn)
    add(`src:${s.id}`, `Source: ${s.id}`, s.ok !== false, s.ok === false ? (s.error || "adapter error") : `${s.count} matches`);
  }
  add("rankings", "Rankings", (h.rankings || 0) > 0, `${h.rankings || 0} lists`);                     // warn

  const fails = checks.filter((c) => c.status === "FAIL");
  const down = fails.some((c) => c.name === "fresh" || c.name === "volume");
  const overall = fails.length === 0 ? "ok" : down ? "down" : "warn";
  return json({ overall, generated_at: h.generated_at, age_min: Math.round(ageMin), checks });
}
