// Sporteaser — the OTHER live-score provider behind padelfip.com.
//
// Not a standalone federation adapter: it is a live-DETAIL source for events the
// fip adapter has already discovered. Some FIP events are scored on Crionet
// (widget.matchscorerlive.com — see adapters/fip.js), others on Sporteaser, and
// the two are mutually exclusive per event. Where Sporteaser is in use, Crionet's
// `tournamentlive` board comes back with ZERO match rows and the order-of-play
// widget leaves an in-progress match as "- - -" until it completes. So without
// this module a Sporteaser-scored event silently shows every live match as
// upcoming with no score, and only fills in after the fact.
//
// Verified 2026-08-26 against FIP Gold Belgrade 2026 (sporteaser tournamentId 397,
// crionet FIP-2026-3507): Crionet live board empty, OOP blank mid-match, while
// Sporteaser served set games, the current game score and the serving side.
//
// Two hops:
//   1. padelfip's own `livescore_tab_load` admin-ajax gives the event's iframe,
//      whose URL carries the sporteaser tournamentId. There is NO list/discovery
//      endpoint on sporteaser itself (public/tournaments, /livematches etc. all
//      404), so this hop is the only way to map event -> tournamentId.
//   2. the widget's backing API, which needs no auth at all. The JS bundle ships a
//      hardcoded `Authorization` JWT but the endpoint ignores it — don't extract it.
//
// An empty `html` from step 1 means the organiser configured no live scoring for
// that event (both FIP Bronze events checked the same day returned exactly that),
// which is a normal, non-error outcome. Coverage is per-event, never tour-wide.

import { STATUS } from "../schema.js";

export const id = "sporteaser";

const API = "https://v0.sporteaser.app/api/public";
const AJAX = "https://www.padelfip.com/wp-admin/admin-ajax.php";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Referer: "https://www.padelfip.com/",
  Accept: "application/json, text/html",
};

// Discovery is two fetches of padelfip per event, so it is cached per process
// (the refresh loop is long-lived). A hit is stable for the life of a tournament;
// a miss is re-checked sooner, because an organiser can switch live scoring on
// partway through an event.
const HIT_TTL = 6 * 60 * 60_000;
const MISS_TTL = 30 * 60_000;
const idCache = new Map(); // eventLink -> { tid, at }

/**
 * Map a padelfip event page to its sporteaser tournamentId.
 * Returns null when the event has no live-score widget configured.
 */
export async function discoverTournamentId(eventLink, log = () => {}) {
  const hit = idCache.get(eventLink);
  if (hit && Date.now() - hit.at < (hit.tid ? HIT_TTL : MISS_TTL)) return hit.tid;

  let tid = null;
  try {
    const html = await (await fetch(eventLink, { headers: HEADERS })).text();
    const postId = (html.match(/postid-(\d+)/) || [])[1];
    // The nonce is per-page and short-lived; it lives in the inline
    // `padelfip_ajax = {...}` blob alongside the ajax url.
    const nonce = (html.match(/padelfip_ajax\s*=\s*\{[^}]*"nonce":"([a-f0-9]+)"/) || [])[1];
    if (!postId || !nonce) throw new Error("no postid/nonce on event page");

    const body = new URLSearchParams({ action: "livescore_tab_load", security: nonce, post_id: postId });
    const res = await fetch(AJAX, {
      method: "POST",
      headers: {
        ...HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });
    const json = await res.json();
    // `html: ""` = no live scoring for this event. Not an error.
    tid = (String(json?.data?.html || "").match(/tournamentId=(\d+)/) || [])[1] || null;
  } catch (err) {
    log(`    · sporteaser discovery skipped for ${eventLink} — ${err.message}`);
  }
  idCache.set(eventLink, { tid, at: Date.now() });
  return tid;
}

/**
 * All matches sporteaser holds for one day of a tournament.
 * `day` is a DAY-OF-MONTH (not a play-day ordinal); the response's own `days`
 * array lists the valid ones, so an out-of-range day is caught rather than
 * silently returning another day's card.
 */
export async function fetchDay(tid, day, log = () => {}) {
  try {
    const res = await fetch(`${API}/tournament/${tid}/matches/day/${day}/sort/fieldname/0`, { headers: HEADERS });
    if (!res.ok) return [];
    const json = await res.json();
    if (Array.isArray(json?.days) && !json.days.includes(Number(day))) return [];
    return (json.matches || []).map(record).filter(Boolean);
  } catch (err) {
    log(`    · sporteaser day ${day} of ${tid} skipped — ${err.message}`);
    return [];
  }
}

// ---- normalization ---------------------------------------------------------

// matchStatus is sporteaser's own enum. 1/2/4 are the three seen in the wild;
// anything else falls back to the presence of `endAt`, which is set exactly when
// a match has finished.
const STATUS_BY_CODE = { 1: STATUS.UPCOMING, 2: STATUS.LIVE, 4: STATUS.FINAL };

// Sets arrive as flat per-period keys, and a key is ABSENT when that side has 0
// games — so "missing" means zero, and only a period where BOTH sides are absent
// is genuinely unplayed.
const PERIODS = ["First", "Second", "Third", "Fourth", "Fifth"];

function record(m) {
  if (!m?.homeTeam || !m?.awayTeam) return null;
  const r = m.results || {};
  const status = STATUS_BY_CODE[m.matchStatus] || (m.endAt ? STATUS.FINAL : STATUS.UPCOMING);

  const sets = [];
  const tb = [];
  for (const p of PERIODS) {
    const h = r[`matchHomeTeam${p}PeriodScore`];
    const a = r[`matchAwayTeam${p}PeriodScore`];
    if (h === undefined && a === undefined) break;
    sets.push([h ?? 0, a ?? 0]);
    const ht = r[`matchHomeTeam${p}PeriodTBScore`];
    const at = r[`matchAwayTeam${p}PeriodTBScore`];
    tb.push(ht === undefined && at === undefined ? null : [ht ?? 0, at ?? 0]);
  }
  // A set that has just started sits at 0-0 with no keys at all; pointHistory
  // still knows it exists, so pad rather than lose the set number.
  const played = m.pointHistory?.results;
  if (status === STATUS.LIVE && Array.isArray(played)) {
    while (sets.length < played.length) {
      sets.push([0, 0]);
      tb.push(null);
    }
  }

  return {
    matchId: m.id,
    court: m.fieldName || null,
    courtNo: courtNo(m.fieldName),
    startAt: m.startAt || null,
    round: m.round ?? null,
    status,
    sides: [side(m.homeTeam, m.homeTeamLineup), side(m.awayTeam, m.awayTeamLineup)],
    sets,
    tb: tb.some(Boolean) ? tb : null,
    // Current game score. Only meaningful while on court — a finished match keeps
    // stale "0"/"0" in these fields, which must never be published as a score.
    points:
      status === STATUS.LIVE && (r.matchHomeTeamCurrentStatus != null || r.matchAwayTeamCurrentStatus != null)
        ? [String(r.matchHomeTeamCurrentStatus ?? ""), String(r.matchAwayTeamCurrentStatus ?? "")]
        : null,
    serving: status === STATUS.LIVE ? serving(m) : null,
    winner:
      status === STATUS.FINAL && r.matchHomeTeamScore !== r.matchAwayTeamScore
        ? r.matchHomeTeamScore > r.matchAwayTeamScore
          ? 0
          : 1
        : null,
  };
}

// `teamInPossession` was null on every live match measured, so the serving side
// is read from the last game of the last set in pointHistory instead.
function serving(m) {
  const sets = m.pointHistory?.results;
  if (!Array.isArray(sets) || !sets.length) return null;
  const games = sets[sets.length - 1];
  if (!Array.isArray(games) || !games.length) return null;
  const onServe = games[games.length - 1]?.status?.onServe;
  if (!onServe || typeof onServe.homeOnServe !== "boolean") return null;
  return onServe.homeOnServe ? 0 : 1;
}

const courtNo = (name) => {
  const n = (String(name || "").match(/(\d+)/) || [])[1];
  return n ? Number(n) : null;
};

function side(team, lineup) {
  // team.name is "Full Name/Full Name"; the lineup carries the same players with
  // their country as a full ENGLISH name, never a code.
  const names = String(team?.name || "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  const players = names.map((name, i) => ({
    name,
    country: iso2(lineup?.[i]?.player?.country?.name),
  }));
  return { name: names.join(" / ") || "TBD", players };
}

// Emit a real ISO 3166-1 alpha-2 or null — never a half-recognised label. Same
// rule the rankedin adapter learned the hard way with its "rin" sentinel.
const ISO2 = {
  argentina: "AR", australia: "AU", austria: "AT", belgium: "BE", brazil: "BR", bulgaria: "BG",
  chile: "CL", croatia: "HR", "czech republic": "CZ", czechia: "CZ", denmark: "DK", ecuador: "EC",
  egypt: "EG", estonia: "EE", finland: "FI", france: "FR", germany: "DE", "great britain": "GB",
  greece: "GR", hungary: "HU", iceland: "IS", ireland: "IE", israel: "IL", italy: "IT", japan: "JP",
  kuwait: "KW", latvia: "LV", lithuania: "LT", mexico: "MX", monaco: "MC", morocco: "MA",
  netherlands: "NL", "the netherlands": "NL", norway: "NO", paraguay: "PY", peru: "PE", poland: "PL",
  portugal: "PT", qatar: "QA", romania: "RO", russia: "RU", "saudi arabia": "SA", serbia: "RS",
  slovakia: "SK", slovenia: "SI", "south africa": "ZA", spain: "ES", sweden: "SE", switzerland: "CH",
  turkey: "TR", "türkiye": "TR", ukraine: "UA", "united arab emirates": "AE",
  "united kingdom": "GB", "united states": "US", uruguay: "UY", venezuela: "VE",
};
const iso2 = (name) => ISO2[String(name || "").trim().toLowerCase()] || null;

// ---- matching a sporteaser record to an already-parsed fip match -----------

// The two providers write names differently: Crionet abbreviates the given name
// ("O. Guy De Chamisso"), sporteaser spells it out and sometimes puts the surname
// FIRST ("Radu Alice", "Kutuzova Vlada"). So match on the Crionet SURNAME being
// contained in the sporteaser full name with all separators removed — that holds
// in both name orders and survives multi-word surnames. Seeding/qualifier markers
// ("(4)", "(Q)") are stripped: they appear on one side only.
const flat = (s) => String(s).replace(/\(\w+\)/g, "").toLowerCase().replace(/[^a-z]/g, "");
const surname = (s) => {
  const parts = String(s).replace(/\(\w+\)/g, "").trim().split(/\s+/);
  // "M. Vives" / "M Vives" -> drop the leading initial; anything else is kept whole.
  if (parts.length > 1 && /^[A-Za-z]\.?$/.test(parts[0])) parts.shift();
  return flat(parts.join(""));
};

const sideMatches = (fipPlayers, spPlayers) => {
  if (!fipPlayers?.length || !spPlayers?.length) return false;
  const pool = spPlayers.map((p) => flat(p.name));
  return fipPlayers.every((p) => {
    const s = surname(p.name || p);
    return s.length >= 3 && pool.some((full) => full.includes(s));
  });
};

/**
 * Overlay sporteaser live detail onto fip matches, in place.
 * Only touches matches that are not already FINAL — the order-of-play widget is
 * authoritative for completed matches and already carries their full score.
 * Returns the number of matches enriched.
 */
export function attach(matches, records, log = () => {}) {
  let n = 0;
  for (const m of matches) {
    if (m.status === STATUS.FINAL) continue;
    const fipSides = m.teams.map((t) => t.players);
    const hits = [];
    for (const rec of records) {
      if (sideMatches(fipSides[0], rec.sides[0].players) && sideMatches(fipSides[1], rec.sides[1].players)) {
        hits.push({ rec, flipped: false });
      } else if (sideMatches(fipSides[0], rec.sides[1].players) && sideMatches(fipSides[1], rec.sides[0].players)) {
        hits.push({ rec, flipped: true });
      }
    }
    // Short surnames can in principle collide; the court number is an independent
    // corroborator (Crionet "Court 3" == sporteaser "Teren 3").
    let pick = hits[0];
    if (hits.length > 1) {
      const c = courtNo(m.court);
      pick = hits.find((h) => c != null && h.rec.courtNo === c);
      if (!pick) {
        log(`    · sporteaser: ambiguous match for ${m.id}, left alone`);
        continue;
      }
    }
    if (!pick) continue;

    const { rec, flipped } = pick;
    const orient = (pair) => (pair && flipped ? [pair[1], pair[0]] : pair);
    if (rec.sets.length) m.score.sets = rec.sets.map((s) => orient(s));
    if (rec.tb) m.raw = { ...(m.raw || {}), tb: rec.tb.map((s) => (s ? orient(s) : null)) };
    if (rec.points) m.score.points = orient(rec.points);
    if (rec.serving != null) m.score.serving = flipped ? (rec.serving === 0 ? 1 : 0) : rec.serving;
    if (rec.winner != null) m.score.winner = flipped ? (rec.winner === 0 ? 1 : 0) : rec.winner;
    // The OOP leaves an in-progress match blank, so this is where a Sporteaser-scored
    // event stops reading as "upcoming" while it is actually on court.
    if (rec.status !== STATUS.UPCOMING) m.status = rec.status;
    if (m.status !== STATUS.UPCOMING) {
      m.estStart = null;
      m.estStartAt = null;
    }
    m.raw = { ...(m.raw || {}), liveSource: "sporteaser", sporteaserId: rec.matchId };
    n++;
  }
  return n;
}

/** Day-of-month out of a Crionet play-day label ("AUG 26" -> 26). */
export const dayOfMonth = (label) => {
  const d = (String(label || "").match(/\b(\d{1,2})\b/) || [])[1];
  return d ? Number(d) : null;
};
