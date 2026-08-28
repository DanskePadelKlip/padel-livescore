// GET /api/pair/:a/:b — one partnership: record, rivals and every match the two
// players played TOGETHER (D1).
//
// A pair is two players on the SAME SIDE of a match. The ids are interchangeable,
// so every query below is order-independent; the page route canonicalises the URL
// to sorted order so /pair/A/B and /pair/B/A aren't two crawlable copies of one
// page.
//
// NOTE ON BOUND PARAMETERS: D1 caps a statement at 100 bound parameters, which is
// why the sibling /api/h2h slices its match-id list to 100. Nothing here builds an
// IN (?,?,…) list at all — the participants query re-derives the pair's match ids
// as a subquery — so a partnership with 300 matches is reported in full instead of
// silently truncated at 100.
import { isFinal, setsAndGames, formAndStreak, bestResult, pct, scoreFrom } from "../../../_stats.js";
import { identifyPlayer } from "../../../_shared.js";

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

// Elo is only comparable inside its own (source, pool) — men and women are rated
// separately, and so are the RankedIn and FIP tours (see the note in
// /api/player/:id). Averaging a FIP rating with a Nordic one, or a men's with a
// women's, produces a number that means nothing, so `combined` stays null unless
// both ratings come from the same population.
function combineElo(ea, eb) {
  if (!ea || !eb || ea.rating == null || eb.rating == null) return null;
  if (ea.source !== eb.source || ea.pool !== eb.pool) return null;
  return { rating: Math.round((ea.rating + eb.rating) / 2), source: ea.source, pool: ea.pool };
}

export async function onRequestGet({ params, env }) {
  const a = params.a, b = params.b;
  if (!a || !b || a === b) return json({ error: "need two distinct player ids" }, 400);

  const [pa, pb] = await Promise.all([identifyPlayer(env, a), identifyPlayer(env, b)]);
  if (!pa || !pb) return json({ error: "not found" }, 404);

  // Elo per player, and the pair average when the two are comparable. Wrapped:
  // player_elo is loaded by a separate padel-db export step, so a deploy landing
  // before the first upload must degrade to "no rating", never 500 the page.
  let ea = null, eb = null;
  try {
    const q = (id) => env.DB.prepare(
      `SELECT source,pool,rating,"rank" AS rank,"of" AS of,n_matches,peak,peak_date FROM player_elo WHERE id=?1`
    ).bind(id).first();
    [ea, eb] = await Promise.all([q(a), q(b)]);
  } catch { /* table not created yet */ }

  // Every match the two played on the same side. Two bound parameters, no id list.
  const { results: mrows } = await env.DB.prepare(
    `SELECT m.id,m.date,m.round,m.class,m.score,m.winner_side,m.source,
            t.name tname,t.federation,t.key tkey,p1.side side,p1.is_winner win
     FROM match_players p1
     JOIN match_players p2 ON p2.match_id=p1.match_id AND p2.side=p1.side AND p2.player_id=?2
     JOIN matches m ON m.id=p1.match_id
     JOIN tournaments t ON t.key=m.tkey
     WHERE p1.player_id=?1
     ORDER BY m.date DESC`
  ).bind(a, b).all();

  const players = { a: pa, b: pb, elo: { a: ea, b: eb, combined: combineElo(ea, eb) } };
  if (!mrows.length) {
    return json({ players, summary: { total: 0, wins: 0, losses: 0, byYear: [] }, rivals: [], matches: [] });
  }

  // Participants of exactly those matches — same subquery, so still two params.
  const { results: parts } = await env.DB.prepare(
    `SELECT match_id,side,pos,player_id,name,country,is_winner FROM match_players
     WHERE match_id IN (
       SELECT p1.match_id FROM match_players p1
       JOIN match_players p2 ON p2.match_id=p1.match_id AND p2.side=p1.side AND p2.player_id=?2
       WHERE p1.player_id=?1
     )`
  ).bind(a, b).all();
  const byMatch = {};
  for (const p of parts) (byMatch[p.match_id] ||= []).push(p);

  const matches = mrows.map((m) => ({
    id: m.id, date: m.date, round: m.round, className: m.class, score: m.score,
    winner_side: m.winner_side, source: m.source, tournament: m.tname, federation: m.federation,
    side: m.side, won: m.win === 1,
    teams: teams(byMatch[m.id] || []),
  }));

  // ---- record ----
  const total = matches.length;
  const wins = matches.filter((m) => m.won).length;

  const yearMap = new Map();
  for (const m of matches) {
    if (!m.date) continue;
    const yr = m.date.slice(0, 4);
    const y = yearMap.get(yr) || { yr, played: 0, won: 0 };
    y.played++; if (m.won) y.won++;
    yearMap.set(yr, y);
  }
  const byYear = [...yearMap.values()].sort((x, y) => y.yr.localeCompare(x.yr));

  // Rows in the shape _stats.js expects (newest first, as ordered above).
  const rows = mrows.map((m) => ({
    round: m.round, score: m.score, side: m.side, win: m.win, date: m.date, tournament: m.tname,
  }));
  const finalRows = rows.filter((r) => isFinal(r.round));
  const { sets, games } = setsAndGames(rows);
  const { form, streak, streakType } = formAndStreak(rows);

  const dated = matches.filter((m) => m.date).map((m) => m.date);
  const first = dated.length ? dated[dated.length - 1] : null;
  const last = dated.length ? dated[0] : null;

  // ---- rivals: group the OPPOSING side across every match together ----
  // Keyed on the opponents' ids so one duo stays one row however their names are
  // abbreviated between sources ("A. Coello" vs "Arturo Coello"); an opponent
  // with no id at all falls back to a name key, matching favKey() in app.js.
  const rivals = new Map();
  for (const m of matches) {
    const opp = m.teams[m.side === 1 ? 1 : 0];
    if (!opp || !opp.players.length) continue;
    const key = opp.players.map((p) => p.id || "n:" + p.name).sort().join("|");
    let r = rivals.get(key);
    if (!r) {
      // `matches` is date-DESC, so the first sighting IS the most recent meeting.
      r = {
        key,
        name: opp.name,
        players: opp.players,
        linkable: opp.players.length === 2 && opp.players.every((p) => p.id),
        meetings: 0, wins: 0, losses: 0,
        // The score is turned round to THIS pair's side: the rivalry row reads
        // "Last: won 6-3 6-4", and a win from side 2 printed side-1-first would
        // say "won 3-6 4-6".
        last: {
          date: m.date, round: m.round, tournament: m.tournament,
          score: scoreFrom(m.score, m.side), won: m.won,
        },
      };
      rivals.set(key, r);
    }
    r.meetings++;
    if (m.won) r.wins++; else r.losses++;
  }
  const rivalList = [...rivals.values()]
    .map((r) => ({ ...r, pct: pct(r.wins, r.losses) }))
    .sort((x, y) => y.meetings - x.meetings || String(y.last.date || "").localeCompare(String(x.last.date || "")));

  return json({
    players,
    summary: {
      total, wins, losses: total - wins, byYear,
      titles: finalRows.filter((r) => r.win === 1).length,
      finals: finalRows.length,
      best: bestResult(rows),
      form, streak, streakType,
      sets, games,
      first, last,
    },
    rivals: rivalList,
    matches,
  });
}
