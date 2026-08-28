// GET /api/pairs — the most-played pairs across the whole archive (D1).
//
// This exists so pair profiles are REACHABLE: a pair page nothing links to is a
// page no crawler finds and no reader stumbles into. It powers /pairs and the
// pair block of sitemap.xml.
//
// There is deliberately no ?player= form. A player's own partnerships come back
// with /api/player/:id, from a GROUP BY that route already runs — asking for
// them here would be a second Function invocation for the same answer.
const json = (d, status = 200, maxAge = 300) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${maxAge}` },
  });

const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// Read the `pairs` roll-up built by scripts/pairs-rollup.sql. Sub-millisecond.
const fromTable = (env, min, limit) =>
  env.DB.prepare(
    `SELECT a,b,na,nb,ca,cb,played,won,last FROM pairs
     WHERE played >= ?1 ORDER BY played DESC, last DESC LIMIT ?2`
  ).bind(min, limit).all();

// Derive the same answer live. Measured at ~2.7 s against a copy of the real
// archive (399k match_players rows), so this is a FALLBACK ONLY — for the window
// between deploying this route and running scripts/pairs-rollup.sql, and for the case where
// an archive import has landed but the roll-up has not been rebuilt yet. A slow
// correct list beats an empty Pairs page.
// `p2.player_id > p1.player_id` both de-duplicates the partnership and gives the
// row the same a/b ordering that /pair/:a/:b canonicalises to.
const computeLive = (env, min, limit) =>
  env.DB.prepare(
    `SELECT p1.player_id a, p2.player_id b, p1.name na, p2.name nb, p1.country ca, p2.country cb,
            COUNT(*) played,
            SUM(CASE WHEN p1.is_winner=1 THEN 1 ELSE 0 END) won,
            MAX(m.date) last
     FROM match_players p1
     JOIN match_players p2 ON p2.match_id=p1.match_id AND p2.side=p1.side AND p2.player_id > p1.player_id
     JOIN matches m ON m.id=p1.match_id
     WHERE p1.player_id IS NOT NULL
     GROUP BY p1.player_id, p2.player_id
     HAVING played >= ?1
     ORDER BY played DESC, last DESC
     LIMIT ?2`
  ).bind(min, limit).all();

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url).searchParams;
  const limit = clampInt(u.get("limit"), 1, 500, 100);
  // Floor of 2, matching the roll-up's own HAVING: asking for min=1 and being
  // handed a list that quietly starts at 2 would misreport what it contains.
  // Both listings want repeat partnerships anyway — a one-match pair still has a
  // page, reached from either player's profile.
  const min = clampInt(u.get("min"), 2, 100, 5);

  // Prefer the roll-up; fall back if the table is missing (throws) or empty
  // (present but never built). `source` is reported so a slow /pairs is
  // diagnosable from the payload instead of guessed at.
  let results = null, source = "table";
  try {
    ({ results } = await fromTable(env, min, limit));
  } catch { results = null; }
  if (!results || !results.length) {
    ({ results } = await computeLive(env, min, limit));
    source = "live";
  }

  // Cached hard: the answer moves at the pace of tournaments, not seconds, and
  // the fallback path must never be re-run per request.
  return json(
    {
      min,
      source,
      pairs: results.map((r) => ({
        a: r.a, b: r.b,
        name: `${r.na} / ${r.nb}`,
        players: [{ id: r.a, name: r.na, country: r.ca }, { id: r.b, name: r.nb, country: r.cb }],
        played: r.played, won: r.won || 0, lost: r.played - (r.won || 0), last: r.last,
      })),
      truncated: results.length === limit,
    },
    200,
    21600
  );
}
