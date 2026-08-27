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
import { fetchClub } from "../rankedin-club.js";
import { STATUS, gid } from "../schema.js";
import { iso2 } from "../iso.js";

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
        const hostClub = await fetchClub(ev.eventId); // cached; null when no club is connected
        const matches = await fetchTournamentMatches(ev.eventId);
        for (const m of matches) out.push(normalize(m, ev, fed, hostClub));
      } catch (err) {
        log(`    ! tournament ${ev.eventId} (${ev.eventName}) failed — ${err.message}`);
      }
      await sleep(150); // be polite to the API
    }
  }

  // Country-level discovery via RankedIn's GLOBAL padel calendar. The org loop above
  // only sees events hosted under a federation's own org (DK/SE/DE/CZ); most nations'
  // clubs host under separate orgs, so those matches are invisible to org discovery.
  // One calendar query (sport=5 = padel) returns padel events across ALL countries in
  // a window; we fetch each one's matches and tag the federation by the event's own
  // country. Overlap with org-covered countries is skipped; any residual dupes dedupe
  // by match id in aggregate. This is what unlocks HR/EE/GE/HU/UA/SI/RO/ZA/MD/… .
  try {
    const calEvents = await discoverCalendarEvents(date);
    log(`  calendar: ${calEvents.length} padel events in non-org countries around ${date}`);
    for (const ev of calEvents) {
      try {
        const hostClub = await fetchClub(ev.eventId); // cached; null when no club is connected
        const matches = await fetchTournamentMatches(ev.eventId);
        for (const m of matches) out.push(normalize(m, ev, { code: ev.country }, hostClub));
      } catch (err) {
        log(`    ! calendar tournament ${ev.eventId} (${ev.eventName}) failed — ${err.message}`);
      }
      await sleep(120);
    }
  } catch (err) {
    log(`  calendar discovery failed — ${err.message}`);
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

// Padel = RankedIn sportId 5 (verified 2026-07-20). Window around the target day so
// the day strip gets recent finals + current + near-upcoming; bounded by CAL_MAX so
// a busy week can't explode the match-fetch count.
const PADEL_SPORT = 5, CAL_BACK = 3, CAL_FWD = 3, CAL_MAX = 40;
const ORG_COUNTRIES = new Set(RANKEDIN_FEDERATIONS.map((f) => f.code.toLowerCase()));
const shiftISO = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function discoverCalendarEvents(date) {
  const lo = shiftISO(date, -CAL_BACK), hi = shiftISO(date, CAL_FWD);
  const data = await rankedinGet(
    `calendar/GetEventsAsync?from=0&take=100&country=0&sport=${PADEL_SPORT}&eventType=0&eventState=0` +
    `&startDate=${lo}&endDate=${hi}&calendarAgeGroups=0&calendarDateFilter=2&calendarOrganization=0`
  );
  return Object.values(data || {})
    .filter((e) => e && e.EventId && e.CountryShort && !ORG_COUNTRIES.has(e.CountryShort.toLowerCase()))
    .slice(0, CAL_MAX)
    .map((e) => ({
      eventId: e.EventId,
      eventName: e.EventName,
      eventUrl: e.EventUrl,
      startDate: e.StartDate,
      endDate: e.EndDate || e.StartDate,
      country: e.CountryShort.toUpperCase(),
      address: e.Address || null,          // full postal string (calendar feed carries it)
      // NOT an organiser, despite the name: RankedIn's calendar `OrganisationName` is the
      // ranking an event counts toward — the only live values are "Liga", "No ranking",
      // "SAPA ranking". It was wired into Event `organizer` until 2026-07-27 and Google
      // flagged the result. The real organiser comes from rankedin-club.js. Do not rename
      // this back.
      ranking: e.OrganisationName || null,
    }));
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

// `hostClub` is the ORGANISER ({name,url} or null) from rankedin-club.js — not to be
// confused with `ev.club`, which is the per-org feed's bare venue name.
function normalize(m, ev, fed, hostClub = null) {
  // Venue/address for Event structured data. Two discovery paths carry it differently:
  // the global calendar feed has a full postal `address`; the per-org feed has `club` +
  // `city` instead. Fold both into one optional shape on the tournament.
  //
  // The organiser comes from neither feed — it needs a per-tournament lookup. Its name and
  // URL are written as a pair or not at all, because a name without a URL is exactly the
  // incomplete `organizer` Google rejected.
  const venue = ev.club || null;
  const address = ev.address || ev.city || null;
  const ranking = ev.ranking || null;
  return {
    id: gid("rankedin", m.Id),
    source: "rankedin",
    federation: fed.code,
    tournament: {
      id: ev.eventId,
      name: ev.eventName,
      url: "https://www.rankedin.com" + (ev.eventUrl || ""),
      ...(venue ? { venue } : {}),
      ...(address ? { address } : {}),
      ...(hostClub ? { organizer: hostClub.name, organizerUrl: hostClub.url } : {}),
      ...(ranking ? { ranking } : {}),
      ...(ev.startDate ? { start: String(ev.startDate).slice(0, 10) } : {}),
      ...(ev.endDate ? { end: String(ev.endDate).slice(0, 10) } : {}),
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
  if (side.Name) players.push({ name: side.Name, country: iso2(side.CountryShort) });
  if (side.Player2Name) players.push({ name: side.Player2Name, country: iso2(side.Player2CountryShort) });
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
