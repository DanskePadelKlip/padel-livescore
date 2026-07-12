// RankedIn adapter — the workhorse. ONE adapter covers every federation that
// runs on RankedIn (DK, SE, DE, ... — see federations.js), because the API is
// org-agnostic.
//
// Flow per federation:
//   1. GetOrganisationEventsAsync(org)      -> tournaments (with start/end dates)
//   2. keep tournaments whose date range covers the target day
//   3. GetMatchesSectionAsync(eventId)      -> every match in that tournament
//   4. normalize() each match -> NormalizedMatch
//
// Everything downstream (aggregate, UI) only sees NormalizedMatch.

import { rankedinGet, sleep } from "../http.js";
import { RANKEDIN_FEDERATIONS } from "../federations.js";
import { STATUS, gid } from "../schema.js";

export const id = "rankedin";

/**
 * @param {Object} opts
 * @param {string} [opts.date]          target day, "YYYY-MM-DD" (default: today)
 * @param {Array}  [opts.federations]   subset of RANKEDIN_FEDERATIONS
 * @param {number} [opts.eventLimit]    events fetched per federation before date-filtering
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<import("../schema.js").NormalizedMatch[]>}
 */
export async function fetchMatches({
  date = todayISO(),
  federations = RANKEDIN_FEDERATIONS,
  eventLimit = 60,
  log = () => {},
} = {}) {
  const out = [];
  for (const fed of federations) {
    let events;
    try {
      events = await discoverEvents(fed, eventLimit);
    } catch (err) {
      log(`  ${fed.code}: event discovery failed — ${err.message}`);
      continue;
    }
    const active = events.filter((e) => coversDay(e, date));
    log(`  ${fed.code}: ${active.length}/${events.length} tournaments active on ${date}`);

    for (const ev of active) {
      try {
        const matches = await fetchTournamentMatches(ev.eventId);
        for (const m of matches) out.push(normalize(m, ev, fed));
      } catch (err) {
        log(`    ! tournament ${ev.eventId} (${ev.eventName}) failed — ${err.message}`);
      }
      await sleep(150); // be polite to the API
    }
  }
  return out;
}

// ---- discovery -------------------------------------------------------------

async function discoverEvents(fed, take) {
  const data = await rankedinGet(
    `organization/GetOrganisationEventsAsync?organisationId=${fed.org}&language=en&skip=0&take=${take}`
  );
  return data?.payload ?? [];
}

async function fetchTournamentMatches(eventId) {
  const data = await rankedinGet(
    `tournament/GetMatchesSectionAsync?id=${eventId}&language=en`
  );
  return data?.Matches ?? [];
}

// A tournament "covers" the target day if day ∈ [startDate, endDate].
function coversDay(ev, day) {
  const start = (ev.startDate || "").slice(0, 10);
  const end = (ev.endDate || ev.startDate || "").slice(0, 10);
  if (!start) return false;
  return start <= day && day <= end;
}

// ---- normalization ---------------------------------------------------------

function normalize(m, ev, fed) {
  return {
    id: gid("rankedin", m.Id),
    source: "rankedin",
    federation: fed.code,
    tournament: {
      id: ev.eventId,
      name: ev.eventName,
      url: "https://www.rankedin.com" + (ev.eventUrl || ""),
    },
    className: m.TournamentClassName || null,
    round: m.Draw || null,
    court: m.Court || null,
    status: mapStatus(m),
    startTime: cleanDate(m.Date) || ev.startDate || null,
    teams: [team(m.Challenger), team(m.Challenged)],
    score: parseScore(m),
    raw: {
      state: m.State,                       // source enum — kept for live-state calibration
      isPlayed: !!m.MatchResult?.IsPlayed,
    },
  };
}

function team(side) {
  side = side || {};
  const players = [];
  if (side.Name) players.push({ name: side.Name, country: side.CountryShort || null });
  if (side.Player2Name) players.push({ name: side.Player2Name, country: side.Player2CountryShort || null });
  const name = players.map((p) => p.name).join(" / ") || side.Name || "TBD";
  return { name, players };
}

function parseScore(m) {
  const s = m.MatchResult?.Score;
  if (!s) return { sets: [], winner: null };
  const sets = (s.DetailedScoring || []).map((g) => [g.FirstParticipantScore, g.SecondParticipantScore]);
  let winner = null;
  if (m.MatchResult?.IsPlayed && typeof s.IsFirstParticipantWinner === "boolean") {
    winner = s.IsFirstParticipantWinner ? 0 : 1;
  }
  return { sets, winner };
}

// RankedIn exposes match state as an int enum. Confirmed: 6 = played/final.
// The exact "live" value needs a tournament in progress to pin down, so for
// Phase 0 we derive status from the data (played? partial score present?) and
// keep raw.state so we can calibrate the enum precisely once we catch a live one.
function mapStatus(m) {
  const r = m.MatchResult;
  if (r?.IsPlayed) return STATUS.FINAL;
  const hasPartialScore =
    Array.isArray(r?.Score?.DetailedScoring) && r.Score.DetailedScoring.length > 0;
  if (hasPartialScore) return STATUS.LIVE; // scored but not finalized -> in progress
  return STATUS.UPCOMING;
}

// "0001-01-01T00:00:00" is RankedIn's null-date placeholder.
function cleanDate(d) {
  if (!d || d.startsWith("0001")) return null;
  return d;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
