// GET /api/matchup?a1=&a2=&b1=&b2= — what these two teams have already done to each
// other (D1). Ids come from /api/search; a2 / b2 are optional, because a live-feed
// name doesn't always resolve to a profile.
import { pairOdds } from "../_stats.js";

const json = (d, status = 200) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });

// A tie-break set is stored as "66" (6 games, tie-break 6) — take the games digit only.
const gameOf = (c) => { const m = /^([67])\d+$/.exec(String(c)); return m ? +m[1] : (parseInt(c, 10) || 0); };

// "6-4 6-3" read from `side`'s point of view
function tally(score, side) {
  const out = { setsWon: 0, setsLost: 0, gamesWon: 0, gamesLost: 0 };
  const mine = side === 1 ? 0 : 1;
  for (const set of String(score || "").trim().split(/\s+/)) {
    const p = set.split("-");
    if (p.length !== 2) continue;
    const my = gameOf(p[mine]), op = gameOf(p[1 - mine]);
    out.gamesWon += my; out.gamesLost += op;
    if (my > op) out.setsWon++; else if (op > my) out.setsLost++;
  }
  return out;
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url).searchParams;
  const A = [u.get("a1"), u.get("a2")].filter(Boolean);
  const B = [u.get("b1"), u.get("b2")].filter(Boolean);
  if (!A.length || !B.length) return json({ error: "need at least a1 & b1" }, 400);
  if (A.some((id) => B.includes(id))) return json({ error: "same player on both sides" }, 400);

  const ids = [...new Set([...A, ...B])];
  const ph = ids.map((_, i) => `?${i + 1}`).join(",");

  const { results: prows } = await env.DB.prepare(
    `SELECT id,name,country FROM players WHERE id IN (${ph})`
  ).bind(...ids).all();
  const byId = Object.fromEntries(prows.map((p) => [p.id, p]));

  // One pass over every match any of these players appear in; everything below is
  // derived in memory rather than with a query per pairing.
  const { results: rows } = await env.DB.prepare(
    `SELECT mp.match_id mid, mp.player_id pid, mp.side side,
            m.date date, m.round round, m.class cls, m.score score, m.winner_side ws,
            t.name tname, t.federation fed
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     JOIN tournaments t ON t.key = m.tkey
     WHERE mp.player_id IN (${ph})
     ORDER BY m.date DESC
     LIMIT 6000`
  ).bind(...ids).all();

  // Elo for the (at most four) players named. A four-row PK lookup, wrapped like
  // every other player_elo read: the table is loaded by a separate job.
  let elo = {};
  try {
    const { results: er } = await env.DB.prepare(
      `SELECT id,source,pool,rating,"rank" AS rank,"of" AS of,n_matches
       FROM player_elo WHERE id IN (${ph})`
    ).bind(...ids).all();
    elo = Object.fromEntries(er.map((e) => [e.id, e]));
  } catch { /* table not created yet */ }

  // Career record per player, derived from the rows ALREADY fetched above -
  // deliberately not a second query. `rows` is every match these players appear
  // in, so a win is (that match's winner_side === the side they were on).
  const record = {};
  for (const id of ids) record[id] = { played: 0, won: 0 };
  const seenRow = new Set();
  for (const r of rows) {
    const key = r.pid + ":" + r.mid;
    if (seenRow.has(key)) continue;
    seenRow.add(key);
    const rec = record[r.pid];
    if (!rec) continue;
    rec.played++;
    if (r.ws === r.side) rec.won++;
  }

  const byMatch = new Map();
  for (const r of rows) {
    let e = byMatch.get(r.mid);
    if (!e) byMatch.set(r.mid, (e = { meta: r, side: {} }));
    e.side[r.pid] = r.side;
  }

  // the side a whole team sat on, or null if they weren't all there / weren't together
  const sideOf = (e, list) => {
    const s = list.map((p) => e.side[p]).filter((x) => x != null);
    return s.length === list.length && s.every((x) => x === s[0]) ? s[0] : null;
  };

  const pair = { n: 0, aWins: 0, bWins: 0, sets: { a: 0, b: 0 }, games: { a: 0, b: 0 }, list: [] };
  // `together` catches the good one: two players on opposite sides tonight who used to
  // partner each other.
  const cross = [];
  for (const a of A) for (const b of B) cross.push({ a, b, n: 0, aWins: 0, bWins: 0, together: 0, togetherWins: 0 });
  const partners = {};
  if (A.length === 2) partners.a = { n: 0, wins: 0 };
  if (B.length === 2) partners.b = { n: 0, wins: 0 };

  for (const e of byMatch.values()) {
    const m = e.meta;
    const sa = sideOf(e, A), sb = sideOf(e, B);

    // how each pair does when they play together, whoever they're up against
    if (partners.a && sa != null) { partners.a.n++; if (m.ws === sa) partners.a.wins++; }
    if (partners.b && sb != null) { partners.b.n++; if (m.ws === sb) partners.b.wins++; }

    // player vs player, regardless of who they were partnered with — and, when they
    // shared a side, the fact that tonight's opponents used to play together
    for (const c of cross) {
      const x = e.side[c.a], y = e.side[c.b];
      if (x == null || y == null) continue;
      if (x === y) { c.together++; if (m.ws === x) c.togetherWins++; continue; }
      c.n++;
      if (m.ws === x) c.aWins++; else if (m.ws === y) c.bWins++;
    }

    // the headline: both full pairs, on opposite sides of the same match
    if (A.length === 2 && B.length === 2 && sa != null && sb != null && sa !== sb) {
      pair.n++;
      const aWon = m.ws === sa;
      if (aWon) pair.aWins++; else if (m.ws === sb) pair.bWins++;
      const t = tally(m.score, sa);
      pair.sets.a += t.setsWon; pair.sets.b += t.setsLost;
      pair.games.a += t.gamesWon; pair.games.b += t.gamesLost;
      if (pair.list.length < 20)
        pair.list.push({
          id: m.mid, date: m.date, round: m.round, className: m.cls, score: m.score,
          tournament: m.tname, federation: m.fed, aWon,
        });
    }
  }

  // The match's own win probability, when all four are rated in one pool.
  const odds = pairOdds(A.map((i) => elo[i]), B.map((i) => elo[i]));

  return json({
    players: Object.fromEntries(ids.map((i) => [i, byId[i] || null])),
    a: A, b: B, pair, cross: cross.filter((c) => c.n > 0 || c.together > 0), partners,
    elo, record, odds,
  });
}
