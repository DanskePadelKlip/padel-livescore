// GET /api/search?q=  — player search by name (D1)
const json = (d) =>
  new Response(JSON.stringify(d), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });

export async function onRequestGet({ request, env }) {
  const q = (new URL(request.url).searchParams.get("q") || "").trim();
  if (q.length < 2) return json({ players: [] });
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.country, p.is_nordic, COUNT(*) matches
     FROM players p JOIN match_players mp ON mp.player_id = p.id
     WHERE p.name LIKE ?1
     GROUP BY p.id
     ORDER BY (p.name LIKE ?2) DESC, matches DESC
     LIMIT 25`
  )
    .bind(`%${q}%`, `${q}%`)
    .all();
  return json({ players: results });
}
