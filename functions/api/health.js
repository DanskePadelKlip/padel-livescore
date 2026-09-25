// GET /api/health — machine-readable health for the Control Tower + edge watchdog.
// Reads the pipeline's health.json (raw facts written each refresh) and derives a
// verdict, INCLUDING a live freshness check: if the refresh job dies, generated_at
// goes stale and this reports "down" even though the last data still says ok — the
// dead-man's switch. Shape ({overall, checks:[{status:"PASS"|"FAIL"}]}) matches
// what control-tower/build_status.ps1 Ping() expects.
const FRESH_MIN = 60; // refresh runs every 15 min; >60 (GH-cron jitter margin) = stale
// A source (FIP, tournamentsoftware, rankedin) failing longer than this is a real
// outage, not a transient scrape blip — escalate it from "warn" to "down" so the
// Control Tower alerts. A single dark cycle stays "warn". Was masked entirely
// before: a browser source dying on a Playwright bump sat at "warn" indefinitely
// while RankedIn alone kept the site "up" at ~1/4 coverage (2026-07-19).
const SOURCE_STALE_HOURS = 3;
// Sources where zero matches is a normal state, not a symptom. puntuate carries FIP
// national-team championships only and is correctly empty between events.
const MAY_BE_EMPTY = new Set(["puntuate"]);

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
  let sourceOutage = false;                                                                           // a source dark past the threshold -> down
  for (const s of h.sources || []) {                                                                  // per-adapter (warn, or down if persistent)
    const failing = s.ok === false;
    // A source that returns ZERO matches without throwing used to pass this check:
    // every adapter turns a discovery failure into `return []`, so "upstream is quiet"
    // and "we could not look" arrived here identically, and whole tournaments could
    // (and did) vanish with every check green. Treat empty as a failure for the
    // sources that always have something, and escalate on the same staleness rule as
    // an erroring one. MAY_BE_EMPTY names the sources where nothing is the norm:
    // puntuate only carries FIP championships and is correctly empty between them.
    const empty = !failing && (s.count || 0) === 0 && !MAY_BE_EMPTY.has(s.id);
    let detail = failing ? (s.error || "adapter error")
      : empty ? "returned 0 matches — cannot distinguish an empty upstream from a silent discovery failure"
      : `${s.count} matches`;
    const since = failing ? s.lastOkAt : empty ? s.lastDataAt : null;
    if ((failing || empty) && since) {
      const staleH = (Date.now() - Date.parse(since)) / 3_600_000;
      if (staleH > SOURCE_STALE_HOURS) { sourceOutage = true; detail = `no data for ${staleH.toFixed(1)}h — ${s.error || (empty ? "0 matches" : "adapter down")}`; }
    }
    add(`src:${s.id}`, `Source: ${s.id}`, !failing && !empty, detail);
  }
  add("rankings", "Rankings", (h.rankings || 0) > 0, `${h.rankings || 0} lists`);                     // warn

  const fails = checks.filter((c) => c.status === "FAIL");
  const critical = fails.some((c) => c.name === "fresh" || c.name === "volume") || sourceOutage;
  const overall = fails.length === 0 ? "ok" : critical ? "down" : "warn";
  return json({ overall, generated_at: h.generated_at, age_min: Math.round(ageMin), checks });
}
