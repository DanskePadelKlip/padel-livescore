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
import * as racketscore from "./racketscore.js";

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
  // The calendar path is BUDGETED; the org loop above is not. rankedin runs at minMs 0,
  // i.e. every cycle, because the Nordic org events are what carry the live scores.
  // Widening the calendar to the whole week takes it from 6 tournaments to ~32, but a
  // FULL pass costs ~150s of round trips - run inline every cycle that would stall the
  // live board for over two minutes at a time. So the pass is spread out: discover once
  // per CAL_TTL_MS, then work through the events under a per-cycle wall-clock budget,
  // always emitting everything fetched so far. Coverage ramps to the full set over a few
  // minutes, the cached rows stay on the site throughout, and no single cycle is blocked.
  const passDone = _cal.cursor >= _cal.events.length;
  if (_cal.date !== date || (passDone && Date.now() - _cal.completedAt >= CAL_TTL_MS)) {
    try {
      const evs = await discoverCalendarEvents(date);
      if (_cal.date !== date) _cal.byEvent = new Map();   // new day - drop yesterday's rows
      _cal.date = date;
      _cal.events = evs;
      _cal.cursor = 0;
      log(`  calendar: ${evs.length} padel events around ${date}`);
    } catch (err) {
      log(`  calendar discovery failed — ${err.message}`);
    }
  }
  const calDeadline = Date.now() + CAL_BUDGET_MS;
  let fetched = 0;
  while (_cal.cursor < _cal.events.length && Date.now() < calDeadline) {
    const ev = _cal.events[_cal.cursor++];
    try {
      const hostClub = await fetchClub(ev.eventId); // cached; null when no club is connected
      const matches = await fetchTournamentMatches(ev.eventId);
      _cal.byEvent.set(ev.eventId, matches.map((m) => normalize(m, ev, { code: ev.country }, hostClub)));
    } catch (err) {
      log(`    ! calendar tournament ${ev.eventId} (${ev.eventName}) failed — ${err.message}`);
    }
    fetched++;
    await sleep(120);
  }
  if (_cal.events.length && _cal.cursor >= _cal.events.length) _cal.completedAt = Date.now();
  for (const arr of _cal.byEvent.values()) out.push(...arr);
  log(`  calendar: +${fetched} event(s) this cycle, ${_cal.byEvent.size} held, cursor ${_cal.cursor}/${_cal.events.length}`);

  // Danish (and other RacketScore-scored) events publish NOTHING live through RankedIn:
  // the organiser scores in the on-court referee app and types only the finished result
  // here, so mapStatus below can never see a partial score and every match goes
  // upcoming -> final. Overlay the referee app's own boards on top. Never fails the
  // adapter: a RacketScore outage leaves these matches exactly as RankedIn gave them.
  try {
    await racketscore.applyLiveDetail(out, log);
  } catch (err) {
    log(`  racketscore overlay failed — ${err.message}`);
  }

  return out;
}

// ---- discovery -------------------------------------------------------------

// TEAM LEAGUES ARE A DIFFERENT ID NAMESPACE — the single most damaging trap in this
// adapter. Both discovery feeds mix tournaments (`type` 4) with team leagues (`type` 3,
// eventUrl `/teamleague/...`), and GetMatchesSectionAsync lives in the TOURNAMENT
// namespace only. Feeding it a team-league id does NOT return empty: it returns
// whichever unrelated tournament happens to own that integer. Measured 2026-08-28 —
// teamleague 957 "Lunar Ligaen 4P - Efterår 2026" was publishing 205 matches from a
// foreign Feb-2020 event (match ids ~284k against the day's ~6.75M) under the Danish
// league's name, and that junk group's size floated it to the top of Denmark.
// Team leagues need teamleague/GetPoolsInfoAsync + GetStandingsSectionAsync (see
// padel-db/dpf_league.js for the endpoint chain). Until that adapter exists, dropping
// them is strictly better than printing another event's matches under their name.
const isTournament = (e) =>
  e && e.type !== 3 && !/\/teamleague\//.test(e.eventUrl || e.EventUrl || "") && e.Type !== 3;

async function discoverEvents(fed, take) {
  const data = await rankedinGet(
    `organization/GetOrganisationEventsAsync?organisationId=${fed.org}&language=en&skip=0&take=${take}`
  );
  return (data?.payload ?? []).filter(isTournament);
}

// Padel = RankedIn sportId 5 (verified 2026-07-20). Window around the target day so
// the day strip gets recent finals + current + near-upcoming; bounded by CAL_MAX so
// a busy week can't explode the match-fetch count.
const PADEL_SPORT = 5, CAL_BACK = 3, CAL_FWD = 3, CAL_MAX = 40;
// See the budget note in fetchMatches: a full calendar pass is ~150s of round trips,
// so it is spread across cycles rather than run inline. TTL is how often the event
// LIST is re-discovered; BUDGET is the most wall-clock one cycle may spend fetching.
const CAL_TTL_MS = 15 * 60_000;
const CAL_BUDGET_MS = 12_000;
let _cal = { date: null, events: [], cursor: 0, byEvent: new Map(), completedAt: 0 };
const ORG_COUNTRIES = new Set(RANKEDIN_FEDERATIONS.map((f) => f.code.toLowerCase()));
const shiftISO = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function discoverCalendarEvents(date) {
  const lo = shiftISO(date, -CAL_BACK), hi = shiftISO(date, CAL_FWD);
  // TWO date-filter modes, merged. Mode 2 returns only what is IN PROGRESS at query
  // time - 16 events against ~100 upstream for the same window, so ~88% of the week
  // was never requested. Mode 3 returns the week but drops some long-running club
  // leagues mode 2 catches (the 481-match Venezuelan one, and BA). Neither is a
  // superset of the other, so union them and dedupe by EventId.
  const seen = new Map();
  for (const mode of [2, 3]) {
    let data;
    try {
      data = await rankedinGet(
        `calendar/GetEventsAsync?from=0&take=100&country=0&sport=${PADEL_SPORT}&eventType=0&eventState=0` +
        `&startDate=${lo}&endDate=${hi}&calendarAgeGroups=0&calendarDateFilter=${mode}&calendarOrganization=0`
      );
    } catch { continue; }
    for (const e of Object.values(data || {})) {
      if (e && e.EventId && e.CountryShort && !seen.has(e.EventId)) seen.set(e.EventId, e);
    }
  }
  // No org-country exclusion any more. The org loop only sees events hosted under a
  // federation's OWN org, so a CLUB-hosted Danish event was invisible to both paths -
  // measured 2026-09-23, Danish tournament 70941 was live upstream with 48 matches and
  // absent from the site. Overlap is harmless: aggregate dedupes by match id.
  return [...seen.values()]
    .filter((e) => e && e.EventId && e.CountryShort)
    .filter(isTournament)   // the calendar feed carries team leagues too (Type 3)
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
  // DetailedScoring is per-SET for an ordinary draw, but for a TEAM TIE it is a SINGLE
  // entry holding the tie's GAMES aggregate, while the real rubber tally (3-0, 2-1) sits
  // on the top-level score. Publishing the aggregate as a set gave scores like 41-28, and
  // on 7 of 85 Czech Extraliga ties it showed the WINNER with the lower number.
  //
  // The guard is deliberately narrow. Measured over 449 played matches on 2026-09-23:
  // a length-1 DetailedScoring appears ONLY in the tie event (73 of them, values 24-43)
  // and never in an ordinary draw, where every played match has >= 2 sets. The >15 test
  // is belt and braces - the largest real cell is a super-tiebreak around 11.
  // Length 0 is left ALONE on purpose: 58 ordinary-draw matches also have no detailed
  // scoring, and there the top-level pair is a SET tally, so publishing it would print
  // "2-0" in a set cell. Showing nothing, as today, beats inventing a score.
  const detailed = s.DetailedScoring || [];
  const aggregate = detailed.length === 1 &&
    Math.max(detailed[0].FirstParticipantScore || 0, detailed[0].SecondParticipantScore || 0) > 15 &&
    typeof s.FirstParticipantScore === "number" && typeof s.SecondParticipantScore === "number";
  const sets = aggregate
    ? [[s.FirstParticipantScore, s.SecondParticipantScore]]
    : detailed.map((g) => [g.FirstParticipantScore, g.SecondParticipantScore]);
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
