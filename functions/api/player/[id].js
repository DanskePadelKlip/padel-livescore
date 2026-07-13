// GET /api/player/:id — one player's profile: summary + recent matches (D1)
const json = (d, status = 200) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });

function teams(ps) {
  const by = { 1: [], 2: [] };
  for (const p of ps) (by[p.side] || by[1]).push(p);
  const side = (s) => ({
    name: by[s].sort((a, b) => (a.pos || 0) - (b.pos || 0)).map((p) => p.name).join(" / ") || "TBD",
    players: by[s].map((p) => ({ id: p.player_id, name: p.name, country: p.country })),
    won: by[s].some((p) => p.is_winner === 1),
  });
  return [side(1), side(2)];
}

export async function onRequestGet({ params, env }) {
  const id = params.id;
  const player = await env.DB.prepare("SELECT id,name,country,is_nordic FROM players WHERE id=?1").bind(id).first();
  if (!player) return json({ error: "not found" }, 404);

  const { results: byYear } = await env.DB.prepare(
    `SELECT substr(m.date,1,4) yr, COUNT(*) played, SUM(CASE WHEN mp.is_winner=1 THEN 1 ELSE 0 END) won
     FROM match_players mp JOIN matches m ON m.id=mp.match_id
     WHERE mp.player_id=?1 AND m.date IS NOT NULL GROUP BY yr ORDER BY yr DESC`
  ).bind(id).all();

  const { results: mrows } = await env.DB.prepare(
    `SELECT m.id,m.date,m.round,m.class,m.score,m.winner_side,m.source,t.name tname,t.federation,t.key tkey
     FROM match_players mp JOIN matches m ON m.id=mp.match_id JOIN tournaments t ON t.key=m.tkey
     WHERE mp.player_id=?1 ORDER BY m.date DESC LIMIT 60`
  ).bind(id).all();

  const ids = mrows.map((m) => m.id);
  let parts = [];
  if (ids.length) {
    const ph = ids.map((_, i) => `?${i + 1}`).join(",");
    parts = (await env.DB.prepare(`SELECT match_id,side,pos,player_id,name,country,is_winner FROM match_players WHERE match_id IN (${ph})`).bind(...ids).all()).results;
  }
  const byMatch = {};
  for (const p of parts) (byMatch[p.match_id] ||= []).push(p);

  const matches = mrows.map((m) => ({
    id: m.id, date: m.date, round: m.round, className: m.class, score: m.score,
    winner_side: m.winner_side, source: m.source, tournament: m.tname, federation: m.federation,
    teams: teams(byMatch[m.id] || []),
  }));

  const total = byYear.reduce((s, y) => s + y.played, 0);
  const wins = byYear.reduce((s, y) => s + (y.won || 0), 0);
  return json({ player, summary: { total, wins, losses: total - wins, byYear }, matches });
}
