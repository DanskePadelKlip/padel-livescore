// RacketScore adapter — point-level live detail for matches the organiser scores in
// the on-court referee app instead of in RankedIn.
//
// WHY THIS EXISTS. RankedIn is our only Danish source, and rankedin.js can only call a
// match live when RankedIn itself carries a partial score (see its mapStatus). At a DPF
// event the organiser scores in RacketScore and touches RankedIn only to type the
// finished result, so every Danish match goes upcoming -> final and NOTHING is ever
// live. Measured 2026-09-12, DPF500 PadelPadel Aarhus: 162 matches in the feed, 0 live,
// while RacketScore had two semi-finals on court, one of them 6-6 in a tie-break. Across
// all 2440 RankedIn matches that day, zero carried a partial score.
//
// This is an ENRICHMENT adapter, like sporteaser.js and scorebug.js — never a source of
// matches. RacketScore publishes only the courts boarded at that instant and keeps NO
// history (?limit=200, ?all=1, ?finished=1 all still return the live handful), and its
// boards carry no tournament identity beyond the event slug. So it cannot build a draw;
// it overlays live detail onto the matches RankedIn already gave us.
//
// Ported from danskepadelklip-site/functions/api/racketscore.js, which has served this
// exact payload on danskepadelklip.com/live since 2026-09-12. The normalisation
// (normGame/normPoints/normBoard, discovery by today's date window) is that function's,
// kept deliberately close so the two stay comparable. What is new here is attach(): the
// name join onto RankedIn matches, which the site never needed because it renders the
// boards standalone.
//
// READ-ONLY. Only ever GETs. The same host accepts referee writes — never call them.

import { STATUS } from "../schema.js";

export const id = "racketscore";

const RS = "https://api.racketscore.com";
const EVENTS_URL = `${RS}/events/public/`;
// The public API wants a browser UA and a live.racketscore.com origin.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Origin: "https://live.racketscore.com",
  Referer: "https://live.racketscore.com/",
  Accept: "application/json",
};
// Bounded like every adapter fetch (src/http.js): a hung request must not stall the
// refresh cycle.
const REQ_TIMEOUT_MS = 10_000;
const SPORT = "padel";             // the events list carries tennis too
const MAX_CURRENT_EVENTS = 15;     // safety cap on the board fan-out
const EVENTS_TTL_MS = 30 * 60_000; // the events list is ~4 MB and changes on a scale of days

// ---- discovery -------------------------------------------------------------

// Cached per process, like scorebug's baseCache: this runs every refresh cycle and the
// events list is megabytes.
let eventsCache = { at: 0, slugs: [] };

const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 90);

/** Today (YYYY-MM-DD) on the tournament wall clock, to compare against event date windows. */
const copenhagenToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen" }).format(new Date());

async function rsGet(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Slugs of the padel events running today. RacketScore has no cross-event feed — boards
 * are queried one event at a time — so the slugs have to come from somewhere, and
 * discovering them beats a hand-maintained list that goes stale silently.
 */
export async function discoverCurrentSlugs(log = () => {}) {
  if (Date.now() - eventsCache.at < EVENTS_TTL_MS) return eventsCache.slugs;
  try {
    const events = await rsGet(EVENTS_URL);
    const today = copenhagenToday();
    const slugs = (Array.isArray(events) ? events : [])
      .filter(
        (e) =>
          e && !e.is_test && e.sport === SPORT && e.start && e.end &&
          String(e.start).slice(0, 10) <= today && today <= String(e.end).slice(0, 10)
      )
      .map((e) => slugify(e.slug))
      .filter(Boolean)
      .slice(0, MAX_CURRENT_EVENTS);
    eventsCache = { at: Date.now(), slugs };
    return slugs;
  } catch (err) {
    // Keep the last-good slug list rather than going blind for 30 minutes on one hiccup;
    // only the very first failure of a process leaves it empty.
    log(`    ! racketscore: event discovery failed — ${err.message}`);
    eventsCache = { at: Date.now(), slugs: eventsCache.slugs };
    return eventsCache.slugs;
  }
}

// ---- board normalisation ---------------------------------------------------

// A score cell is a bare number OR an object carrying a highlight className, e.g.
// 6 or { games: 6, className: "winner" }. Same for the points cell.
function normGame(g) {
  if (g && typeof g === "object") {
    return { v: g.games != null ? g.games : 0, setWinner: g.className === "winner" };
  }
  return { v: g != null ? g : 0, setWinner: false };
}
function normPoints(p) {
  if (p && typeof p === "object") return p.points != null ? p.points : 0;
  return p != null ? p : 0;
}

function normBoard(b, slug) {
  const d = b.data || {};
  const info = d.info || {};
  return {
    boardId: b.id,
    slug,
    // is_live / is_finished are TOP-LEVEL board fields, not inside data. data.status is a
    // free-text display string ("Tiebreak", ["Winner", "A / B"]) and must not be parsed.
    state: b.is_live ? STATUS.LIVE : b.is_finished ? STATUS.FINAL : STATUS.UPCOMING,
    court: info.court_nr || "",
    round: info.round || "",
    category: info.category || "",
    teams: (d.teams || []).map((t) => ({
      won: !!t.won,
      points: normPoints(t.points),
      games: (t.games || []).map(normGame),
      players: (t.players || []).map((p) => ({
        name: p.name || "",
        country: (p.country || "").toUpperCase(),
      })),
    })),
  };
}

/** Every board currently published for one event. A bad slug contributes nothing. */
export async function fetchBoards(slug, log = () => {}) {
  try {
    const data = await rsGet(`${RS}/boards/${slug}/`);
    return (data?.results || [])
      .filter((b) => !b.is_test)
      .map((b) => normBoard(b, slug))
      .filter((b) => b.teams.length === 2);
  } catch (err) {
    log(`    ! racketscore: boards/${slug} failed — ${err.message}`);
    return [];
  }
}

// ---- matching a board to an already-parsed RankedIn match -------------------

// Both sides spell names in full, so this join is far less fragile than the FIP one in
// sporteaser.js — but it has to survive Danish orthography, which the naive
// strip-everything-but-a-z fold destroys in a way that still looks like a clean miss:
// "Søby" folds to "sby", so it stops matching a source that writes "Soeby" while
// comparing fine against another mangled copy of itself. Map the letters that do NOT
// decompose (ø, æ, and the Icelandic pair) explicitly; NFD handles å, ä, ö, é and the rest.
const FOLD = { "ø": "o", "æ": "ae", "ð": "d", "þ": "th", "ß": "ss" };
const fold = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[øæðþß]/g, (c) => FOLD[c])
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")   // combining marks left by NFD
    .replace(/[^a-z]/g, "");

// NEITHER SIDE IS RELIABLY THE LONGER ONE, so a containment test in a fixed direction
// silently matches nothing. RankedIn carries the full registered name while RacketScore
// carries what the referee typed, and the referee drops trailing surnames: measured
// 2026-09-12, "Rasmus Pauli Aabling" was boarded as "Rasmus Pauli" and "Wilfred Kjær
// Mikkelsen" as "Wilfred Kjær", while other players matched exactly. (The reverse also
// happens — an abbreviated given name, "M. Vives".) So compare TOKEN SETS: the shorter
// name must be a subset of the longer one. Seeding and qualifier markers ("(2)", "(WC)")
// appear on the RankedIn side only and are stripped first.
const tokens = (s) =>
  String(s)
    .replace(/\(\w+\)/g, "")
    .trim()
    .split(/\s+/)
    .map(fold)
    .filter((t) => t.length >= 2);

const playerMatches = (a, b) => {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const set = new Set(big);
  if (!small.every((t) => set.has(t))) return false;
  // Two shared name parts is a person. One is a coincidence waiting to happen
  // ("Rasmus" alone), so a single-token name has to BE the other's surname — which is
  // what a dropped initial leaves behind ("M. Vives" -> "vives").
  return small.length >= 2 || small[0] === big[big.length - 1];
};

const sideMatches = (matchPlayers, boardPlayers) => {
  if (!matchPlayers?.length || !boardPlayers?.length) return false;
  return matchPlayers.every((p) =>
    boardPlayers.some((q) => playerMatches(p.name || p, q.name || q))
  );
};

// NOT fold(): that strips digits, so "D1" and "D2" both collapse to "d" and the court
// stops being able to tell two boards apart — which is the only job it has here.
const courtKey = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "") || null;

/**
 * Overlay RacketScore live detail onto matches, in place. Returns the number enriched.
 *
 * Only touches matches that are not already FINAL: once RankedIn has typed a result it is
 * authoritative and carries the full set score, and a board still sitting on the finished
 * match must not re-open it.
 *
 * UPCOMING boards are skipped entirely. They carry no score (games: []), so they can only
 * move a match's status without adding information — and a referee opening a board early
 * would flip a match to live before anyone is on court.
 */
export function attach(matches, boards, log = () => {}) {
  const pending = matches.filter((m) => m.status !== STATUS.FINAL);
  if (!pending.length) return 0;
  const usable = boards.filter((b) => b.state !== STATUS.UPCOMING);
  if (!usable.length) return 0;

  // Live boards first: if a pair matches both a live board and a just-finished one, what
  // is on court now is the better answer for a match we still think is pending.
  const ordered = [...usable].sort(
    (a, b) => (a.state === STATUS.LIVE ? 0 : 1) - (b.state === STATUS.LIVE ? 0 : 1)
  );

  const claimed = new Set(); // a board can only ever be one match
  let n = 0;

  for (const m of pending) {
    const sides = m.teams.map((t) => t.players);
    const hits = [];
    for (const b of ordered) {
      if (claimed.has(b.boardId)) continue;
      const bp = b.teams.map((t) => t.players);
      if (sideMatches(sides[0], bp[0]) && sideMatches(sides[1], bp[1])) hits.push({ b, flipped: false });
      else if (sideMatches(sides[0], bp[1]) && sideMatches(sides[1], bp[0])) hits.push({ b, flipped: true });
    }
    if (!hits.length) continue;

    // A pair plays several matches in a Monrad day, so a pair-VS-pair hit is normally
    // unique. When it is not, the court is an independent corroborator — but court_nr is
    // often empty on RacketScore (it was empty on every board of the first event sampled),
    // so an ambiguous match with no court to separate it is left alone rather than guessed.
    let pick = hits[0];
    if (hits.length > 1) {
      const c = courtKey(m.court);
      pick = c ? hits.find((h) => courtKey(h.b.court) === c) : null;
      if (!pick) {
        log(`    · racketscore: ambiguous board for ${m.id}, left alone`);
        continue;
      }
    }

    const { b, flipped } = pick;
    const A = flipped ? 1 : 0, B = flipped ? 0 : 1;
    const games = [b.teams[A].games, b.teams[B].games];
    const nSets = Math.max(games[0].length, games[1].length);
    if (nSets) {
      m.score.sets = Array.from({ length: nSets }, (_, i) => [games[0][i]?.v ?? 0, games[1][i]?.v ?? 0]);
    }

    if (b.state === STATUS.LIVE) {
      // Points are the real padel labels, not indices — "", 0, 15, 30, 40, "A" — and in a
      // tie-break they are the tie-break count instead. Pass them through as the strings
      // the schema asks for; never interpret them here.
      m.score.points = [String(b.teams[A].points ?? ""), String(b.teams[B].points ?? "")];
      m.status = STATUS.LIVE;
    } else {
      // FINAL. `won` is the board's own verdict, so we never have to judge sets ourselves.
      const wonA = b.teams[A].won, wonB = b.teams[B].won;
      if (wonA || wonB) m.score.winner = wonA ? 0 : 1;
      m.status = STATUS.FINAL;
      delete m.score.points;
    }

    // An estimated start is meaningless once we know the match is on court or done.
    m.estStart = null;
    m.estStartAt = null;
    // The board often knows the court when the draw does not.
    if (!m.court && b.court) m.court = b.court;
    m.raw = { ...(m.raw || {}), liveSource: "racketscore", racketscoreId: b.boardId, racketscoreSlug: b.slug };

    claimed.add(b.boardId);
    n++;
  }
  return n;
}

/**
 * Discover today's events, pull their boards, and overlay them onto `matches`.
 * Never throws: a RacketScore outage leaves the RankedIn matches exactly as they were.
 */
export async function applyLiveDetail(matches, log = () => {}) {
  const slugs = await discoverCurrentSlugs(log);
  if (!slugs.length) return 0;
  const boards = [];
  for (const slug of slugs) boards.push(...(await fetchBoards(slug, log)));
  if (!boards.length) return 0;
  const n = attach(matches, boards, log);
  const live = boards.filter((b) => b.state === STATUS.LIVE).length;
  log(`  RacketScore: ${slugs.length} event(s), ${boards.length} board(s) (${live} live) — ${n} match(es) live-detailed`);
  return n;
}
