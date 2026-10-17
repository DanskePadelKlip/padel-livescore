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
      const evs = await discoverCalendarEvents(date, log);
      // byEvent is NOT wiped on a new day: the new window still holds yesterday's events,
      // and wiping it emptied the calendar half of the site at every UTC midnight until
      // the pass caught up. Rows of events that left the window go when the pass ends.
      _cal.date = date;
      _cal.events = evs;
      _cal.cursor = 0;
      log(`  calendar: ${evs.length} padel events around ${date}`);
    } catch (err) {
      log(`  calendar discovery failed — ${err.message}`);
    }
  }
  // The budget only has to be tight while matches are live, i.e. while the daemon cycles
  // every ~20s+work. A long gap since the last call means it is pacing at 10-30 min (or
  // has just restarted), so nothing is waiting on this cycle and it can do a bigger
  // slice. Measured 2026-10-17: with 12s on every cycle, a restart at 22:26Z left the
  // site missing most calendar events for ~40 min (four 10-min cycles of ~10 events).
  const idle = Date.now() - _cal.lastRunAt >= CAL_IDLE_GAP_MS;
  _cal.lastRunAt = Date.now();
  const calDeadline = Date.now() + (idle ? CAL_BUDGET_IDLE_MS : CAL_BUDGET_MS);
  let fetched = 0, skipped = 0;
  while (_cal.cursor < _cal.events.length && Date.now() < calDeadline) {
    const ev = _cal.events[_cal.cursor++];
    // An event that is not on the target day (finished earlier in the window, or not
    // started) rarely changes, so its held copy is reused for CAL_COLD_MS instead of
    // spending ~1.2s of the budget on it every pass. Keeps the pass short for today's.
    const at = _cal.fetchedAt.get(ev.eventId);
    if (at && !coversDay(ev, date) && _cal.byEvent.has(ev.eventId) && Date.now() - at < CAL_COLD_MS) {
      skipped++;
      continue;
    }
    try {
      const hostClub = await fetchClub(ev.eventId); // cached; null when no club is connected
      const matches = await fetchTournamentMatches(ev.eventId);
      _cal.byEvent.set(ev.eventId, matches.map((m) => normalize(m, ev, { code: ev.country }, hostClub)));
      _cal.fetchedAt.set(ev.eventId, Date.now());
    } catch (err) {
      log(`    ! calendar tournament ${ev.eventId} (${ev.eventName}) failed — ${err.message}`);
    }
    fetched++;
    await sleep(120);
  }
  if (_cal.events.length && _cal.cursor >= _cal.events.length) {
    _cal.completedAt = Date.now();
    const keep = new Set(_cal.events.map((e) => e.eventId));
    for (const id of _cal.byEvent.keys()) if (!keep.has(id)) { _cal.byEvent.delete(id); _cal.fetchedAt.delete(id); }
  }
  for (const arr of _cal.byEvent.values()) out.push(...arr);
  log(`  calendar: +${fetched} event(s) this cycle${skipped ? `, ${skipped} cold reused` : ""}${idle ? " (idle budget)" : ""}, ${_cal.byEvent.size} held, cursor ${_cal.cursor}/${_cal.events.length}`);

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
// the day strip gets recent finals + current + near-upcoming. CAL_MAX is a safety
// valve only, applied AFTER the events are ordered (calendarPriority) so what it cuts
// is the far edge of the window. It used to be 40 on an unordered list: on Sat
// 2026-10-17 that cut 32 of 72 events, mostly that day's one-day events (Lunar Open
// Aarhus 218 matches, Sportsgroup Denmark Open 104, Padelshoppen Open 87, ...).
const PADEL_SPORT = 5, CAL_BACK = 3, CAL_FWD = 3, CAL_MAX = 200, CAL_PAGE = 100, CAL_PAGES = 5;
// See the budget note in fetchMatches: a full calendar pass is ~1.2s per event (~110s
// for the ~90 events of a Saturday), so it is spread across cycles rather than run
// inline. TTL is how often the event LIST is re-discovered; BUDGET is the most
// wall-clock one cycle may spend fetching, IDLE_BUDGET the most when the previous call
// was at least IDLE_GAP ago (nothing live, or the first cycle after a restart). Both
// stay well inside refresh-loop's 3-min FETCH_MAX_MS.
const CAL_TTL_MS = 15 * 60_000;
const CAL_BUDGET_MS = 12_000;
const CAL_BUDGET_IDLE_MS = 45_000;
const CAL_IDLE_GAP_MS = 3 * 60_000;
const CAL_COLD_MS = 60 * 60_000;
let _cal = { date: null, events: [], cursor: 0, byEvent: new Map(), fetchedAt: new Map(), completedAt: 0, lastRunAt: 0 };
const ORG_COUNTRIES = new Set(RANKEDIN_FEDERATIONS.map((f) => f.code.toLowerCase()));
const shiftISO = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Order of the calendar pass, lowest first: events on the target day that last a few
// days at most (a weekend open - where the day's results are), then long-running
// leagues that span it, then events that finished earlier in the window (newest
// first), then upcoming ones (soonest first). The pass walks this list, so after a
// restart or a rediscovery today's events are on the site within the first cycle.
function calendarPriority(e, day) {
  const start = (e.startDate || "").slice(0, 10), end = (e.endDate || e.startDate || "").slice(0, 10);
  const spanDays = (Date.parse(end) - Date.parse(start)) / 86_400_000 || 0; // undated: treat as one day
  if (start <= day && day <= end) return [spanDays <= 3 ? 0 : 1, spanDays];
  if (end < day) return [2, -Date.parse(end) || 0];
  return [3, Date.parse(start) || 0];
}

async function discoverCalendarEvents(date, log = () => {}) {
  const lo = shiftISO(date, -CAL_BACK), hi = shiftISO(date, CAL_FWD);
  // Date-filter modes, merged. Mode 0 (no filter), PAGED, is the full window: on
  // 2026-10-17 it returned 101 rows (so take=100 alone truncates) and held every event
  // modes 2 and 3 did, plus 14 more starting the next day (incl. 3 Danish events with
  // matches). Modes 2 (in progress now) and 3 are kept as a single page each because
  // 2026-09-23 saw mode 3 drop leagues mode 2 caught (the 481-match Venezuelan one, BA);
  // they cost two calls per discovery. Dedupe by EventId.
  const seen = new Map();
  const add = (data) => {
    const rows = Object.values(data || {}).filter((e) => e && e.EventId);
    for (const e of rows) if (e.CountryShort && !seen.has(e.EventId)) seen.set(e.EventId, e);
    return rows.length;
  };
  const q = (mode, from) =>
    `calendar/GetEventsAsync?from=${from}&take=${CAL_PAGE}&country=0&sport=${PADEL_SPORT}&eventType=0&eventState=0` +
    `&startDate=${lo}&endDate=${hi}&calendarAgeGroups=0&calendarDateFilter=${mode}&calendarOrganization=0`;
  let ok = 0;
  for (let page = 0; page < CAL_PAGES; page++) {
    let n;
    try { n = add(await rankedinGet(q(0, page * CAL_PAGE))); ok++; } catch { break; }
    if (n < CAL_PAGE) break;
    if (page === CAL_PAGES - 1) log(`  calendar: mode 0 still full after ${CAL_PAGES} pages - raise CAL_PAGES`);
  }
  for (const mode of [2, 3]) {
    try { add(await rankedinGet(q(mode, 0))); ok++; } catch { /* the other modes still count */ }
  }
  if (!ok) throw new Error("every calendar query failed");
  // No org-country exclusion any more. The org loop only sees events hosted under a
  // federation's OWN org, so a CLUB-hosted Danish event was invisible to both paths -
  // measured 2026-09-23, Danish tournament 70941 was live upstream with 48 matches and
  // absent from the site. Overlap is harmless: aggregate dedupes by match id.
  const evs = [...seen.values()]
    .filter((e) => e && e.EventId && e.CountryShort)
    .filter(isTournament)   // the calendar feed carries team leagues too (Type 3)
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
  const pri = new Map(evs.map((e) => [e.eventId, calendarPriority(e, date)]));
  evs.sort((a, b) => {
    const x = pri.get(a.eventId), y = pri.get(b.eventId);
    return x[0] - y[0] || x[1] - y[1];
  });
  if (evs.length > CAL_MAX) log(`  calendar: ${evs.length} events, dropping the last ${evs.length - CAL_MAX} (CAL_MAX)`);
  return evs.slice(0, CAL_MAX);
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
      // The per-org feed's town on its own, for /map: `address` above may hold it or a
      // bare street, depending on which discovery path saw the event.
      ...(ev.city ? { city: ev.city } : {}),
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

// "//player/R000144626/asger-andersen" -> "R000144626". The RankedIn id is the
// profile id on PadelTicker, so the match page can find a player without
// guessing from a name (351 Nielsens in the DPF ranking alone).
const ridOf = (url) => { const m = /\/player\/(R\d{6,})/.exec(String(url || "")); return m ? m[1] : null; };

function team(side) {
  side = side || {};
  const players = [];
  const p = (name, country, url) => { const rid = ridOf(url); return rid ? { name, country, rid } : { name, country }; };
  if (side.Name) players.push(p(side.Name, iso2(side.CountryShort), side.Player1Url));
  if (side.Player2Name) players.push(p(side.Player2Name, iso2(side.Player2CountryShort), side.Player2Url));
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
