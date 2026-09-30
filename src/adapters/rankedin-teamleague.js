// RankedIn TEAM-LEAGUE adapter — the Danish Elitedivision and 1. Division.
//
// This is a SECOND adapter against the same API as rankedin.js, and it exists
// because team leagues are a different id namespace with a different endpoint
// chain. rankedin.js deliberately DROPS them (`isTournament`) after teamleague
// 957 published 205 matches from a foreign 2020 event under "Lunar Ligaen":
// GetMatchesSectionAsync does not 404 on a team-league id, it returns whichever
// unrelated tournament owns that integer. Do not merge the two adapters; keeping
// the namespaces apart is the whole point.
//
// Flow:
//   1. GetOrganisationEventsAsync(org, take=200)  -> keep type 3 (team leagues)
//   2. GetPoolsInfoAsync(seasonId)                -> pools, e.g. "Øst - 1. Division - A"
//   3. GetStandingsSectionAsync(season, pool)     -> rounds[] -> every TIE + its tally
//   4. GetTeamLeagueTeamsMatchesAsync(tieId)      -> the RUBBERS inside one tie
//
// Emits two row kinds, the same shape puntuate.js uses for national-team ties:
//   - a TIE row   `rankedin-teamleague:<tieId>`        club vs club, score = rubber tally
//   - RUBBER rows `rankedin-teamleague:<tieId>:m<n>`   the pairs, score = sets
// public/app.js joins the two on that id prefix, so the rubbers render as the
// lineup inside the tie's card and do not also appear as rows of their own.

import { rankedinGet, sleep } from "../http.js";
import { STATUS, gid } from "../schema.js";
import { iso2 } from "../iso.js";

export const id = "rankedin-teamleague";

// Which federations run a team league we cover. One row per federation; the
// endpoints are org-agnostic, so adding Sweden is a row, not code.
const TEAM_LEAGUE_ORGS = [{ code: "DK", org: 1420 }];

// WHICH DIVISIONS. Elitedivisionen and 1. Division only. The Danish pyramid below
// them (2. Division, Danmarksserien, Serie 1-6) is 260 more pools of club padel
// and would bury every other Danish event. Widening coverage is this one regex.
const POOL_RE = /elitedivision|\b1\.\s*division\b/i;

// A league is IN SCOPE only if it has an Elitedivision pool. That is what tells the
// national pyramid (Lunar Ligaen) apart from the parallel association league (Arla
// Protein ForeningsLigaen), whose top tier is ALSO called "1. Division" but is a
// different competition. Matching on the sponsor name instead would break the day a
// sponsor changes — this reads the league's own shape.
const ELITE_RE = /elitedivision/i;

// The org feed puts the team leagues at the END of the list: at take=60 (what
// rankedin.js uses) the DK org returns 60 tournaments and ZERO leagues; the two
// live ones appear only once the whole 150-row list is asked for. A short take
// here covers nothing at all, silently.
const ORG_TAKE = 200;

// Day window for TIE rows, matching the rest of the site's ±3 days. Tie rows are
// free — they all arrive inside the standings call — so this is about what belongs
// on the day strip, not about cost.
const BACK = 3, FWD = 3;
// Rubbers cost one request per tie, so they are only fetched around the target
// day: recent results, today's, and tomorrow's submitted lineups.
const RUB_BACK = 3, RUB_FWD = 1;

// Pool discovery barely changes inside a season; results do. So the pool LIST is
// cached for hours while the standings, which carry the tallies, are re-read every
// run.
const POOLS_TTL_MS = 6 * 60 * 60_000;
let _pools = { at: 0, leagues: [] };
// One standings call per pool is the adapter's whole cost — 12 pools at RankedIn's
// latency measured 10.4 s, which is half a live refresh cycle. A pool's SCHEDULE is
// fixed, so the only pools worth re-reading every run are the ones with a tie on or
// beside the target day; the rest are served from cache until TTL. Measured: 12
// calls down to 2-6.
const TIES_TTL_MS = 30 * 60_000;
const _ties = new Map(); // poolId -> { at, ties }
// A finished tie's rubbers never change again, so they are fetched once. This is
// what keeps a steady cycle at a handful of requests instead of one per tie in the
// whole window.
const _rubbers = new Map(); // tieId -> { rows, final }

/**
 * @param {Object} opts
 * @param {string} [opts.date] target day, "YYYY-MM-DD" (default: today)
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<import("../schema.js").NormalizedMatch[]>}
 */
export async function fetchMatches({ date = todayISO(), log = () => {} } = {}) {
  const out = [];
  let leagues;
  try {
    leagues = await discoverLeagues(date, log);
  } catch (err) {
    log(`  teamleague: discovery failed — ${err.message}`);
    return out;
  }
  if (!leagues.length) {
    log(`  teamleague: no league in season on ${date}`);
    return out;
  }

  const lo = shiftISO(date, -BACK), hi = shiftISO(date, FWD);
  const rubLo = shiftISO(date, -RUB_BACK), rubHi = shiftISO(date, RUB_FWD);

  for (const league of leagues) {
    let ties = 0;
    for (const pool of league.pools) {
      let poolTies;
      try {
        poolTies = await poolTiesCached(league.id, pool, date, log);
      } catch (err) {
        log(`    ! ${league.name} / ${pool.name} failed — ${err.message}`);
        continue;
      }
      for (const tie of poolTies) {
        if (!tie.day || tie.day < lo || tie.day > hi) continue;
        // A tie called off with no result is not an upcoming tie; showing it as one
        // would put a fixture on the day strip that nobody is going to play.
        if (tie.cancelled && !tie.settled) continue;
        let rubbers = [];
        if (tie.day >= rubLo && tie.day <= rubHi) {
          try {
            rubbers = await fetchRubbers(tie);
          } catch (err) {
            log(`    ! tie ${tie.tieId} rubbers failed — ${err.message}`);
          }
        }
        out.push(...tieRows(tie, rubbers, league, pool, date));
        ties++;
      }
    }
    log(`  teamleague ${league.name}: ${ties} tie(s) in window across ${league.pools.length} pool(s)`);
  }
  return out;
}

// ---- discovery -------------------------------------------------------------

async function discoverLeagues(date, log) {
  if (_pools.leagues.length && Date.now() - _pools.at < POOLS_TTL_MS) {
    return _pools.leagues.filter((l) => coversDay(l, date));
  }
  const leagues = [];
  for (const fed of TEAM_LEAGUE_ORGS) {
    const data = await rankedinGet(
      `organization/GetOrganisationEventsAsync?organisationId=${fed.org}&language=en&skip=0&take=${ORG_TAKE}`
    );
    // `type` 3 is a team league. The calendar feed spells the same field `Type`.
    const rows = (data?.payload ?? []).filter(
      (e) => e && (e.type === 3 || e.Type === 3 || /\/teamleague\//.test(e.eventUrl || ""))
    );
    for (const e of rows) {
      const league = {
        id: e.eventId,
        name: e.eventName,
        url: e.eventUrl || `/en/teamleague/${e.eventId}`,
        federation: fed.code,
        startDate: e.startDate,
        endDate: e.endDate || e.startDate,
        pools: [],
      };
      if (!coversDay(league, date)) continue; // don't pay for a season that is over
      let pools;
      try {
        pools = (await rankedinGet(`teamleague/GetPoolsInfoAsync?id=${league.id}&language=en`))?.pools ?? [];
      } catch (err) {
        log(`  teamleague: pools for ${league.id} failed — ${err.message}`);
        continue;
      }
      if (!pools.some((p) => ELITE_RE.test(p.name || ""))) continue; // not the national pyramid
      league.pools = pools.filter((p) => POOL_RE.test(p.name || ""));
      if (league.pools.length) leagues.push(league);
      await sleep(120);
    }
  }
  _pools = { at: Date.now(), leagues };
  log(`  teamleague: ${leagues.length} league(s) in scope — ${leagues.map((l) => `${l.name} (${l.pools.length} pools)`).join(", ")}`);
  return leagues.filter((l) => coversDay(l, date));
}

// A pool is re-read when its cache is cold or stale, and on EVERY run while it has a
// tie on or beside the target day — that is the only window in which a tally can
// change, so it is the only window worth paying for.
async function poolTiesCached(leagueId, pool, date, log) {
  const hit = _ties.get(pool.id);
  const hot = hit && hit.ties.some((t) => t.day && t.day >= shiftISO(date, -1) && t.day <= shiftISO(date, 1));
  if (hit && !hot && Date.now() - hit.at < TIES_TTL_MS) return hit.ties;
  const ties = await fetchPoolTies(leagueId, pool);
  _ties.set(pool.id, { at: Date.now(), ties });
  await sleep(120); // be polite to the API — only on a real request
  return ties;
}

// Every tie in one pool, with the tally RankedIn publishes for it.
async function fetchPoolTies(leagueId, pool) {
  const data = await rankedinGet(
    `teamleague/GetStandingsSectionAsync?teamleagueId=${leagueId}&poolid=${pool.id}&language=en`
  );
  const ties = [];
  for (const round of data?.matchesSectionModel?.rounds ?? []) {
    for (const m of round.matches ?? []) {
      if (!m?.matchId) continue;
      const day = dmyToISO(m.details?.date || round.roundDate);
      ties.push({
        tieId: m.matchId,
        round: m.details?.round ?? round.roundNumber ?? null,
        day,
        startTime: dmyTimeToISO(m.details?.time) || (day ? `${day}T00:00:00` : null),
        venue: m.details?.locationName || null,
        // team1 is the CHALLENGER side of every rubber in the tie — verified
        // 2026-09-30 across all 64 played Elite/1.-Division ties of the season:
        // counting rubbers with isFirstParticipantWinner===true reproduced
        // team1.result exactly, 64 of 64. Never take the order from the standings
        // TABLE, which is sorted by position and swaps the moment a side goes ahead.
        teams: [sideOf(m.team1), sideOf(m.team2)],
        // `showResults` is the tie's own "result is final" flag: true for all 64
        // played ties of the season and for none of the 166 unplayed ones. A tie
        // mid-entry reads false with some rubbers already in.
        settled: m.showResults === true,
        cancelled: m.showCanceledInfoText === true,
      });
    }
  }
  return ties;
}

const sideOf = (t) => ({ name: (t?.name || "TBD").trim(), result: Number(t?.result) || 0, id: t?.id ?? null });

// ---- rubbers ---------------------------------------------------------------

async function fetchRubbers(tie) {
  const hit = _rubbers.get(tie.tieId);
  if (hit && hit.final) return hit.rows;
  const data = await rankedinGet(
    `teamleague/GetTeamLeagueTeamsMatchesAsync?teamMatchId=${tie.tieId}&language=en`
  );
  // The payload is an object keyed "0" — one segment per tie, and only ever one
  // has been seen — each holding { settings, matches: { matches: [...] } }.
  const rows = [];
  for (const seg of Object.values(data || {})) {
    for (const r of seg?.matches?.matches ?? []) rows.push(r);
  }
  _rubbers.set(tie.tieId, { rows, final: tie.settled });
  await sleep(120);
  return rows;
}

// A rubber nobody played. Both shapes have to be handled: `cancellation` is the
// numeric enum on the match (1 Bye, 2 Walkover, 3 Disqualified, 4 Retired,
// 5 NotPlayed) and `matchResult.cancellationStatus` is the same fact as a display
// string — a number-keyed lookup silently matches nothing against the string.
// Walkover / retired / disqualified are NOT void: the rubber was awarded, so the
// winner flag on them is meaningful and the row belongs on the site.
const VOID_CODES = new Set([1, 5]); // bye / not played — no result exists
const voidRubber = (r) => {
  const code = r?.cancellation;
  const text = r?.matchResult?.cancellationStatus || "";
  if (code != null && VOID_CODES.has(Number(code))) return true;
  return /not played|bye/i.test(text);
};
// A lineup that has not been submitted arrives as two players literally named
// "Pending " — padded, so trim before testing.
const pending = (s) => !s || !String(s).trim() || /^pending$/i.test(String(s).trim());

// ---- rows ------------------------------------------------------------------

function tieRows(tie, rubbers, league, pool, date) {
  const decided = rubbers.filter((r) => !voidRubber(r) && winnerOf(r) != null).length;
  const voided = rubbers.filter(voidRubber).length;
  const status = tieStatus(tie, decided + voided, rubbers.length, date);

  const tieId = gid(id, tie.tieId);
  const rows = [
    {
      id: tieId,
      source: id,
      federation: league.federation,
      tournament: event(league),
      className: pool.name,
      round: tie.round != null ? `Runde ${tie.round}` : null,
      // The VENUE, not a court: RankedIn publishes no court for a team match, and a
      // tie is several rubbers on several courts anyway. The club hosting it is what
      // a reader wants in that slot.
      court: tie.venue,
      status,
      startTime: tie.startTime,
      teams: tie.teams.map((t) => ({ name: t.name, players: [] })),
      score: tieScore(tie, status),
      raw: { tie: true, teamMatchId: tie.tieId, poolId: pool.id, rubbers: rubbers.length, settled: tie.settled },
    },
  ];

  rubbers.forEach((r, i) => {
    const row = rubberRow(r, i + 1, tieId, tie, league, pool);
    if (row) rows.push(row);
  });
  return rows;
}

const event = (league) => ({
  id: league.id,
  name: league.name,
  url: "https://www.rankedin.com" + league.url,
  ...(league.startDate ? { start: String(league.startDate).slice(0, 10) } : {}),
  ...(league.endDate ? { end: String(league.endDate).slice(0, 10) } : {}),
});

// Live only while the tie is actually around the target day. A tie whose result
// entry stalled days ago would otherwise sit "live" for the rest of the season;
// no such tie exists in the data (every past tie is settled), so this is a guard
// rather than a workaround for something observed.
function tieStatus(tie, done, total, date) {
  if (tie.settled) return STATUS.FINAL;
  if (!done) return STATUS.UPCOMING;
  if (total && done >= total) return STATUS.FINAL;
  const near = tie.day && tie.day >= shiftISO(date, -1) && tie.day <= shiftISO(date, 1);
  return near ? STATUS.LIVE : STATUS.FINAL;
}

// A tie's score is its rubber TALLY, taken as RankedIn publishes it rather than
// counted here: its own tally already skips the rubbers nobody played, and
// disagreeing with the source about a number the source displays is worse than
// showing none. An unplayed tie shows no score at all, not 0-0.
function tieScore(tie, status) {
  const [a, b] = tie.teams;
  if (status === STATUS.UPCOMING) return { sets: [], winner: null };
  const winner = status === STATUS.FINAL && a.result !== b.result ? (a.result > b.result ? 0 : 1) : null;
  return { sets: [[a.result, b.result]], winner };
}

function rubberRow(r, n, tieId, tie, league, pool) {
  if (voidRubber(r)) return null; // nothing was played; a row for it is noise
  const a = pairOf(r.challenger), b = pairOf(r.challenged);
  if (!a || !b) return null; // lineup not submitted yet
  return {
    id: `${tieId}:m${n}`,
    source: id,
    federation: league.federation,
    tournament: event(league),
    className: pool.name,
    // The tie is the context a lone rubber needs: it is the only thing that says
    // which two clubs this pair is playing for.
    round: `${tie.teams[0].name} v ${tie.teams[1].name}${tie.round != null ? ` · Runde ${tie.round}` : ""} · Kamp ${n}`,
    court: tie.venue,
    // Never LIVE: RankedIn publishes a rubber only once its result has been typed
    // in, so a rubber on court right now is indistinguishable from one that has not
    // started. Verified 2026-09-30 at 19:29 on tie 152740, which started at 19:00 —
    // all seven rubbers still matchResult:null, state 2, isTeamMatchInPlay false.
    status: winnerOf(r) != null ? STATUS.FINAL : STATUS.UPCOMING,
    startTime: cleanDate(r.date) || tie.startTime,
    teams: [a, b],
    score: rubberScore(r),
    raw: { rubberOf: tieId, matchId: r.id ?? null, state: r.state },
  };
}

function pairOf(side) {
  if (!side) return null;
  const players = [];
  for (const [nm, cc] of [[side.name, side.countryShort], [side.player2Name, side.player2CountryShort]]) {
    if (pending(nm)) continue;
    players.push({ name: String(nm).trim(), country: iso2(cc) });
  }
  if (!players.length) return null;
  return { name: players.map((p) => p.name).join(" / "), players };
}

const winnerOf = (r) => {
  const w = r?.matchResult?.score?.isFirstParticipantWinner;
  return typeof w === "boolean" ? (w ? 0 : 1) : null;
};

function rubberScore(r) {
  const s = r?.matchResult?.score;
  if (!s) return { sets: [], winner: null };
  // Only per-set games are published as a score. When detailedScoring is null the
  // source has given sets-WON (2-0) and nothing else; publishing that pair in a set
  // cell is how a board once printed "2-1" for 2-6 6-4 3-6. Show the winner, no score.
  const sets = (s.detailedScoring || []).map(setCell);
  return { sets, winner: winnerOf(r) };
}

// One set as the client wants it: the LOSER's cell carries the tiebreak, encoded as
// <games><points> ("65" renders 6 with a superscript 5 — setParts() in app.js only
// accepts a leading 6 or 7). A deciding match tie-break is published as 1-0 with the
// loser's POINTS in loserTiebreak; that does not fit the encoding, so it is left as
// the bare 1-0 rather than printed as a malformed set.
function setCell(g) {
  const a = num(g.firstParticipantScore), b = num(g.secondParticipantScore);
  const tb = g.loserTiebreak;
  if (tb == null) return [a, b];
  const loserIsA = a < b;
  const games = loserIsA ? a : b;
  if (games !== 6 && games !== 7) return [a, b]; // match tie-break, not a set
  const enc = `${games}${tb}`;
  return loserIsA ? [enc, b] : [a, enc];
}

const num = (v) => (typeof v === "number" ? v : Number(v) || 0);

// ---- dates -----------------------------------------------------------------

// A league "covers" the day if day ∈ [startDate, endDate].
function coversDay(ev, day) {
  const start = (ev.startDate || "").slice(0, 10);
  const end = (ev.endDate || ev.startDate || "").slice(0, 10);
  if (!start) return false;
  return start <= day && day <= end;
}

// "30/09/2026" -> "2026-09-30". The team-league section publishes dd/MM/yyyy in its
// details block, not the ISO the tournament endpoints use.
function dmyToISO(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || "").trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
// "30/09/2026 19:00" -> "2026-09-30T19:00:00" — a naive venue-local stamp, the same
// form rankedin.js passes through, which is what app.js's day strip expects.
function dmyTimeToISO(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4].padStart(2, "0")}:${m[5]}:00` : null;
}
// "0001-01-01T00:00:00" is RankedIn's null-date placeholder.
function cleanDate(d) {
  if (!d || String(d).startsWith("0001")) return null;
  return d;
}
const shiftISO = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function todayISO() { return new Date().toISOString().slice(0, 10); }
