// GET /api/h2h?a=<id>&b=<id> — head-to-head between two players (D1)
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

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url).searchParams;
  const a = u.get("a"), b = u.get("b");
  if (!a || !b) return json({ error: "need a & b" }, 400);
  const pa = await env.DB.prepare("SELECT id,name,country FROM players WHERE id=?1").bind(a).first();
  const pb = await env.DB.prepare("SELECT id,name,country FROM players WHERE id=?1").bind(b).first();
  if (!pa || !pb) return json({ error: "player not found" }, 404);

  const { results: shared } = await env.DB.prepare(
    `SELECT match_id FROM match_players WHERE player_id=?1 INTERSECT SELECT match_id FROM match_players WHERE player_id=?2`
  ).bind(a, b).all();
  const ids = shared.map((r) => r.match_id).slice(0, 100);
  if (!ids.length) return json({ a: pa, b: pb, asOpponents: { list: [], aWins: 0, bWins: 0 }, asPartners: { list: [], wins: 0 } });

  const ph = ids.map((_, i) => `?${i + 1}`).join(",");
  const { results: mrows } = await env.DB.prepare(
    `SELECT m.id,m.date,m.round,m.class,m.score,m.winner_side,t.name tname,t.federation
     FROM matches m JOIN tournaments t ON t.key=m.tkey WHERE m.id IN (${ph}) ORDER BY m.date DESC`
  ).bind(...ids).all();
  const { results: parts } = await env.DB.prepare(`SELECT match_id,side,pos,player_id,name,country,is_winner FROM match_players WHERE match_id IN (${ph})`).bind(...ids).all();
  const byMatch = {};
  for (const p of parts) (byMatch[p.match_id] ||= []).push(p);

  const opp = { list: [], aWins: 0, bWins: 0 };
  const partner = { list: [], wins: 0 };
  for (const m of mrows) {
    const ps = byMatch[m.id] || [];
    const sideA = ps.find((p) => p.player_id === a)?.side;
    const sideB = ps.find((p) => p.player_id === b)?.side;
    if (!sideA || !sideB) continue;
    const entry = { id: m.id, date: m.date, round: m.round, className: m.class, score: m.score, winner_side: m.winner_side, tournament: m.tname, federation: m.federation, teams: teams(ps) };
    if (sideA === sideB) {
      partner.list.push(entry);
      if (m.winner_side === sideA) partner.wins++;
    } else {
      opp.list.push(entry);
      if (m.winner_side === sideA) opp.aWins++;
      else if (m.winner_side === sideB) opp.bWins++;
    }
  }
  return json({ a: pa, b: pb, asOpponents: opp, asPartners: partner });
}
