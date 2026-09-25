// GET /api/player/:id — one player's profile: summary + recent matches (D1)
//
// Titles, form, sets and games come from _stats.js, shared with /api/pair/:a/:b:
// the two pages describe overlapping runs of matches, so they must not disagree
// about what counts as a final or how a tie-break scores.
import { isFinal, setsAndGames, formAndStreak, matchShape } from "../../_stats.js";
import { decodeParam } from "../../_shared.js";

const json = (d, status = 200) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });

// A malformed precomputed blob must not take the profile down; every caller
// treats null as "not available" and falls back or omits the block.
function safeJson(v) {
  if (!v) return null;
  try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; }
}

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

export async function onRequestGet({ params, env, request, waitUntil }) {
  // Edge cache. A profile runs seven D1 queries, several of them whole-career
  // scans, and the same handful of URLs are requested over and over - a crawler
  // walking the sitemap is thousands of identical calls. Serving those from the
  // colo keeps the free tier's 5M rows/day for readers who need fresh data.
  // Deliberately keyed on the request URL and nothing else: this response has no
  // per-visitor content.
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;

  const id = decodeParam(params.id);
  const player = await env.DB.prepare("SELECT id,name,country,is_nordic FROM players WHERE id=?1").bind(id).first();
  if (!player) return json({ error: "not found" }, 404);

  // Biography (padelfip.com profile facts, loaded by padel-db/export_d1_bio.py).
  // Wrapped: the table is populated by a separate job, so a deploy that lands before
  // the first upload must degrade to "no bio", never to a 500 on the whole profile.
  let bio = null;
  try {
    bio = await env.DB.prepare(
      "SELECT birth_date,height_cm,position,birth_place,coaches,partner,photo_url,fip_slug FROM player_bio WHERE player_id=?1"
    ).bind(id).first();
  } catch { /* table not created yet */ }

  // Elo rating + rank within its pool (padel-db/export_d1_elo.py). Wrapped for
  // the same reason as the bio above — the table is loaded by a separate
  // wrangler step, and a deploy landing first must degrade to "no rating"
  // rather than 500 every player page.
  // The rating is ONLY meaningful inside its own (source, pool): men and women
  // are rated separately, and so are the RankedIn and FIP tours. Never render
  // it against a rating carrying a different source/pool.
  // "rank" and "of" are quoted — both are SQLite keywords.
  let elo = null;
  try {
    elo = await env.DB.prepare(
      `SELECT source,pool,rating,"rank" AS rank,"of" AS of,n_matches,peak,peak_date
       FROM player_elo WHERE id=?1`
    ).bind(id).first();
  } catch { /* table not created yet */ }

  // Prize money (padel-db/fip_prize.py -> d1/earnings.sql). Wrapped for the same
  // reason as the bio and Elo above: a separate job loads the table, so a deploy
  // landing first must degrade to "no earnings" rather than 500 every profile.
  // Only players with a fip_player_links entry have a row at all — FIP results are
  // stored under abbreviated names, not RankedIn ids — so a missing row means
  // "not linked, or no priced results", NEVER "earned nothing". Do not render a
  // zero on absence.
  let earnings = null;
  try {
    earnings = await env.DB.prepare(
      "SELECT gender,total,lo,hi,exact,events FROM player_earnings WHERE id=?1"
    ).bind(id).first();
  } catch { /* table not created yet */ }

  // Career aggregates, precomputed by padel-db/export_d1_stats.py.
  //
  // WHY THIS ROW EXISTS. D1's `matches` table only ever held FIP + rin_matches;
  // it has never carried dpf_matches (the authoritative Danish set) or the team
  // league. So the queries below see a fraction of most players' careers -- of
  // the 9,259 men with an Elo rating, 6,761 had ZERO matches here and the median
  // player saw 0% of their own record, while the Elo panel right next to it was
  // built from all of them. Loading every missing match as raw rows costs ~40
  // days of the D1 free tier's write budget and multiplies the cost of exactly
  // the whole-career scans that took this API down on 2026-09-04; one aggregate
  // row per player costs ~27% of ONE day and lets three of those scans go away.
  //
  // Wrapped and optional for the same reason as bio/elo/earnings above: a deploy
  // landing before the first load must degrade to the live queries, never 500.
  // When it IS present we skip the byYear and whole-career queries entirely.
  let stats = null;
  try {
    stats = await env.DB.prepare(
      `SELECT played,won,titles,finals,sets_won,sets_lost,games_won,games_lost,
              scored,form,streak,streak_type,partner_id,partner_name,partner_n,
              partner_won,by_year,shape
       FROM player_stats WHERE id=?1`
    ).bind(id).first();
  } catch { /* table not created yet */ }

  // Only queried when there is no precomputed row to read it from.
  const { results: byYear } = stats ? { results: [] } : await env.DB.prepare(
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

  // `played` counts every decided match from every source. It is deliberately
  // NOT Elo's n_matches, which excludes mixed doubles and anyone whose gender it
  // cannot resolve -- for R000120413 that is 254 played against 244 rated. Both
  // are right; the UI must label them differently or the difference reads as a
  // bug. See the docstring in padel-db/export_d1_stats.py.
  const total = stats ? stats.played : byYear.reduce((s, y) => s + y.played, 0);
  const wins = stats ? stats.won : byYear.reduce((s, y) => s + (y.won || 0), 0);

  // ---- deeper aggregate stats over the player's WHOLE history ----
  // Skipped entirely when the precomputed row is present: this is the query the
  // 2026-09-04 crawl multiplied into a read-budget exhaustion, and it is the one
  // that could only ever see the matches D1 happens to hold.
  const { results: allRows } = stats ? { results: [] } : await env.DB.prepare(
    `SELECT m.round round, m.score score, mp.side side, mp.is_winner win
     FROM match_players mp JOIN matches m ON m.id=mp.match_id
     WHERE mp.player_id=?1 ORDER BY m.date DESC`
  ).bind(id).all();

  // titles & finals. STILL FIP-ONLY, in the precomputed row exactly as here:
  // RankedIn's `round` is a DRAW name ("Elimination", "Monrad", "Pulje A"), never
  // a round, so this has always returned 0 for domestic players and the
  // precomputed row reproduces that rather than inventing a number. National
  // titles need padel-db's dpf_achievements and belong in their own change.
  const finalRows = allRows.filter((r) => isFinal(r.round));
  const titles = stats ? stats.titles : finalRows.filter((r) => r.win === 1).length;
  const finals = stats ? stats.finals : finalRows.length;

  // current form (newest first) + streak
  const live = !stats ? formAndStreak(allRows) : null;
  const form = stats ? String(stats.form || "").split("") : live.form;
  const streak = stats ? stats.streak : live.streak;
  const streakType = stats ? stats.streak_type : live.streakType;

  // sets & games from the score strings. `scored` is how many matches actually
  // carried a readable score -- walkovers, retirements and every team-league
  // match (that table has no score column at all) are excluded, so the
  // percentages must not be presented as covering all `played` matches.
  const liveSG = !stats ? setsAndGames(allRows) : null;
  const pctOf = (w, l) => (w + l ? Math.round((w / (w + l)) * 100) : null);
  const sets = stats
    ? { won: stats.sets_won, lost: stats.sets_lost, pct: pctOf(stats.sets_won, stats.sets_lost) }
    : liveSG.sets;
  const games = stats
    ? { won: stats.games_won, lost: stats.games_lost, pct: pctOf(stats.games_won, stats.games_lost) }
    : liveSG.games;

  // how those matches were won and lost (deciders, straight sets, tie-breaks).
  // The precomputed copy comes from match_shape() in export_d1_stats.py, a port
  // of matchShape() below; tools/shape_parity.mjs checks the two agree.
  const shape = stats ? safeJson(stats.shape) : matchShape(allRows);

  // ---- opponent quality, from the Elo table ----
  // Only meaningful inside ONE (source, pool): a FIP rating and a Nordic one are
  // different scales, so the join pins both to this player's own pool and a
  // player with no rating simply gets nothing.
  //
  // The ratings are the opponents' CURRENT ones, not their rating on the day —
  // player_elo holds one row per player, no history — so everything derived here
  // is labelled "today" in the UI. A rating-at-the-time version needs the
  // per-match Elo table that padel-db computes but does not yet export.
  let quality = null;
  if (elo) {
    try {
      const { results: qrows } = await env.DB.prepare(
        `SELECT mp.match_id mid, MAX(mp.is_winner) win,
                AVG(pe.rating) opp, MIN(pe."rank") best
         FROM match_players mp
         JOIN match_players opp ON opp.match_id=mp.match_id AND opp.side<>mp.side
         JOIN player_elo pe ON pe.id=opp.player_id AND pe.source=?2 AND pe.pool=?3
         WHERE mp.player_id=?1
         GROUP BY mp.match_id`
      ).bind(id, elo.source, elo.pool).all();
      if (qrows.length) {
        const bucket = () => ({ w: 0, l: 0 });
        const q = { rated: qrows.length, top10: bucket(), top50: bucket(), stronger: bucket() };
        let sum = 0;
        for (const r of qrows) {
          const k = r.win === 1 ? "w" : "l";
          sum += r.opp;
          if (r.best <= 10) q.top10[k]++;
          if (r.best <= 50) q.top50[k]++;
          if (r.opp > elo.rating) q.stronger[k]++;
        }
        q.avgOpp = Math.round(sum / qrows.length);
        const best = await env.DB.prepare(
          `SELECT opp.player_id id, opp.name name, pe.rating rating, m.date date, t.name tname
           FROM match_players mp
           JOIN matches m ON m.id=mp.match_id
           JOIN tournaments t ON t.key=m.tkey
           JOIN match_players opp ON opp.match_id=mp.match_id AND opp.side<>mp.side
           JOIN player_elo pe ON pe.id=opp.player_id AND pe.source=?2 AND pe.pool=?3
           WHERE mp.player_id=?1 AND mp.is_winner=1
           ORDER BY pe.rating DESC LIMIT 1`
        ).bind(id, elo.source, elo.pool).first();
        if (best) q.bestWin = { id: best.id, name: best.name, rating: Math.round(best.rating), date: best.date, tournament: best.tname };
        quality = q;
      }
    } catch { /* player_elo absent — the profile just doesn't show this block */ }
  }

  // Every partner this player has played with, most-played first. This used to
  // be LIMIT 1 (just the top partner); it now returns the whole list because the
  // profile links each one to its /pair/:a/:b page, and doing that from the query
  // already running costs nothing — a separate /api/pairs?player= call from the
  // page would be a second Function invocation for the same GROUP BY.
  // Capped so a 20-year club player can't return a 500-row partner list.
  const { results: partners } = await env.DB.prepare(
    `SELECT mp2.name name, mp2.player_id pid, mp2.country country,
            COUNT(*) played, SUM(CASE WHEN mp1.is_winner=1 THEN 1 ELSE 0 END) won,
            MIN(m.date) first, MAX(m.date) last
     FROM match_players mp1
     JOIN match_players mp2 ON mp2.match_id=mp1.match_id AND mp2.side=mp1.side AND mp2.player_id<>mp1.player_id
     JOIN matches m ON m.id=mp1.match_id
     WHERE mp1.player_id=?1 AND mp2.player_id IS NOT NULL
     GROUP BY mp2.player_id ORDER BY played DESC, won DESC LIMIT 60`
  ).bind(id).all();
  const partnerList = partners.map((p) => ({
    id: p.pid, name: p.name, country: p.country,
    matches: p.played, wins: p.won || 0, losses: p.played - (p.won || 0),
    first: p.first, last: p.last,
  }));
  // Kept as its own field: the profile has rendered a single "Top partner" row
  // since before the pair pages existed, and other callers read this shape.
  // The partner LIST can only cover the matches D1 holds as rows, but "who do you
  // play with most" is a career fact, and the precomputed row knows it over the
  // whole history -- 63 matches with one partner where the visible rows show 9.
  // Prefer the precomputed answer; `partnersComplete` tells the page the list
  // underneath is a subset so it can say so instead of contradicting the totals.
  const tp = partnerList[0];
  const topPartner = stats && stats.partner_id
    ? { name: stats.partner_name, id: stats.partner_id,
        matches: stats.partner_n, wins: stats.partner_won }
    : (tp ? { name: tp.name, id: tp.id, matches: tp.matches, wins: tp.wins } : null);

  const res = json({
    player,
    bio,
    elo,
    earnings,
    summary: {
      total, wins, losses: total - wins,
      byYear: stats ? (safeJson(stats.by_year) || []) : byYear,
      titles, finals,
      form, streak, streakType,
      sets, games, shape, scored: stats ? stats.scored : (shape && shape.scored),
      // Tells the page (and anyone reading the JSON) whether the numbers above
      // cover the whole career or only the matches D1 holds as rows.
      complete: !!stats,
    },
    quality,
    topPartner,
    partners: partnerList,
    // The partner and match lists are limited to the matches D1 holds as rows;
    // the summary above is not. False whenever the two disagree.
    partnersComplete: !stats || total <= matches.length,
    matches,
  });
  // 30 minutes: the refresh daemon updates the feed far more often than a
  // player's CAREER record changes, and a stale W-L for half an hour is a much
  // smaller problem than the API being down for everyone.
  res.headers.set("cache-control", "public, max-age=1800");
  if (waitUntil) waitUntil(cache.put(request, res.clone()));
  return res;
}
