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

  // ---- deeper aggregate stats over the player's WHOLE history ----
  const { results: allRows } = await env.DB.prepare(
    `SELECT m.round round, m.score score, mp.side side, mp.is_winner win
     FROM match_players mp JOIN matches m ON m.id=mp.match_id
     WHERE mp.player_id=?1 ORDER BY m.date DESC`
  ).bind(id).all();

  // titles & finals ("final" as a whole word, excluding semi/quarter)
  const isFinal = (r) => r && /\bfinals?\b/i.test(r) && !/semi|quarter|1\/[0-9]/i.test(r);
  const finalRows = allRows.filter((r) => isFinal(r.round));
  const titles = finalRows.filter((r) => r.win === 1).length;

  // current form (newest first) + streak
  const form = allRows.slice(0, 12).map((r) => (r.win === 1 ? "W" : "L"));
  let streak = 0;
  const s0 = allRows[0]?.win;
  for (const r of allRows) { if (r.win === s0) streak++; else break; }

  // sets & games from the score strings (games digit only, so tie-breaks like "66" count as 6)
  const gameOf = (c) => { const m = /^([67])\d+$/.exec(String(c)); return m ? +m[1] : (parseInt(c, 10) || 0); };
  let setsWon = 0, setsLost = 0, gamesWon = 0, gamesLost = 0;
  for (const r of allRows) {
    if (!r.score) continue;
    const mine = r.side === 1 ? 0 : 1;
    for (const set of String(r.score).trim().split(/\s+/)) {
      const p = set.split("-");
      if (p.length !== 2) continue;
      const my = gameOf(p[mine]), op = gameOf(p[1 - mine]);
      gamesWon += my; gamesLost += op;
      if (my > op) setsWon++; else if (op > my) setsLost++;
    }
  }
  const pct = (w, l) => (w + l ? Math.round((w / (w + l)) * 100) : null);

  // most frequent partner + record together
  const { results: partner } = await env.DB.prepare(
    `SELECT mp2.name name, mp2.player_id pid, COUNT(*) played, SUM(CASE WHEN mp1.is_winner=1 THEN 1 ELSE 0 END) won
     FROM match_players mp1
     JOIN match_players mp2 ON mp2.match_id=mp1.match_id AND mp2.side=mp1.side AND mp2.player_id<>mp1.player_id
     WHERE mp1.player_id=?1 AND mp2.player_id IS NOT NULL
     GROUP BY mp2.player_id ORDER BY played DESC, won DESC LIMIT 1`
  ).bind(id).all();
  const tp = partner[0];
  const topPartner = tp ? { name: tp.name, id: tp.pid, matches: tp.played, wins: tp.won } : null;

  return json({
    player,
    summary: {
      total, wins, losses: total - wins, byYear,
      titles, finals: finalRows.length,
      form, streak, streakType: s0 === 1 ? "W" : "L",
      sets: { won: setsWon, lost: setsLost, pct: pct(setsWon, setsLost) },
      games: { won: gamesWon, lost: gamesLost, pct: pct(gamesWon, gamesLost) },
    },
    topPartner,
    matches,
  });
}
