// GET /api/elos?ids=a,b,c — today's Elo for a list of player ids (D1 player_elo).
// For the match page's Events tab: the partner beside each result and the pair
// that ended each run, so a commentator can judge what a result was worth.
// Primary-key reads only, at most MAX ids, cached an hour at the edge: one call
// per opened tab is ~100 row reads, nothing like a profile's history scans.
//
// -> { id: [rating, source, pool, n_matches] }. A rating only compares inside
// its own (source, pool) - the client checks that before putting two side by side.
const MAX = 300;
const CHUNK = 90;  // D1 binds at most 100 parameters per statement

const json = (d) =>
  new Response(JSON.stringify(d), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
  });

export async function onRequestGet({ request, env }) {
  const raw = new URL(request.url).searchParams.get("ids") || "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, MAX);
  const out = {};
  for (let i = 0; i < ids.length; i += CHUNK) {
    const ch = ids.slice(i, i + CHUNK);
    const ph = ch.map((_, k) => `?${k + 1}`).join(",");
    try {
      const { results } = await env.DB.prepare(
        `SELECT id,source,pool,rating,n_matches FROM player_elo WHERE id IN (${ph})`
      ).bind(...ch).all();
      for (const r of results) out[r.id] = [Math.round(r.rating), r.source, r.pool, r.n_matches];
    } catch { /* table not loaded yet: no ratings, the tab still renders */ }
  }
  return json(out);
}
