// FIP / Premier Padel adapter. The pro tour's match data is NOT in padelfip.com
// HTML — it's in an embedded matchscorerlive widget (server-rendered HTML).
// Method (per the DPK padel-db work):
//   1. discover in-play tournaments via padelfip WordPress REST (recent `modified`)
//   2. read each event page for its `idEvent` -> matchscorer id `FIP-{year}-{idEvent}`
//   3. fetch the current day's Order-of-Play widget (completed + live + upcoming)
//   4. parse the widget HTML (in-process, via linkedom) -> normalize
//
// The widget is server-rendered HTML, so no headless browser is needed — a plain
// fetch + linkedom DOM parse gets everything. This keeps FIP off Playwright (lean,
// resilient, runs unattended) and cheap enough that we no longer cap how many
// tournaments we pull. The widget 403s without a browser UA + `Referer: padelfip.com`.

import { parseHTML } from "linkedom";
import { STATUS, gid } from "../schema.js";
import * as sporteaser from "./sporteaser.js";

export const id = "fip";

const FIP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Referer: "https://www.padelfip.com/",
  Accept: "text/html,application/json",
};
const WIDGET = "https://widget.matchscorerlive.com/screen";
const WP = "https://www.padelfip.com/wp-json/wp/v2";
// The order-of-play widget above carries SET games only. The live board is a
// separate view of the same Crionet data — same markup family (.double
// .line-thin, img.flags, td.set) — and it additionally carries the current game
// points (td.points) and a ball icon on the serving team (img.ballg), plus a
// warm-up state. This is what padelfip.com's own "Live Score" tab embeds
// (verified 2026-08-03: it reloads that iframe every 20s). It only ever lists
// matches currently on court, so it is fetched per event and merged onto the
// matches the OOP already produced — never as a source of matches itself.
const LIVE_BOARD = `${WIDGET}/tournamentlive`;

export async function fetchMatches({ date = todayISO(), maxTournaments = Infinity, maxDay = 9, log = () => {} } = {}) {
  const events = await discoverActiveEvents(date, log);
  // No browser: the widget is server-rendered HTML we fetch + parse in-process, so
  // every discovered tournament is cheap. `maxTournaments` defaults to no limit (a
  // caller can still bound it). This is why Premier Padel P1 events — which on busy
  // days sort past the old 15-tournament cap behind dozens of Bronze/Silver events
  // touched the same day — are no longer silently dropped.
  const active = Number.isFinite(maxTournaments) ? events.slice(0, maxTournaments) : events;
  log(`  FIP: ${active.length} pro-tour tournament(s) in play around ${date}`);
  if (!active.length) return [];

  const out = [];
  for (const ev of active) {
    try {
      const msId = await matchscorerId(ev);
      if (!msId) {
        log(`    ! ${ev.slug}: no idEvent on event page`);
        continue;
      }
      const days = await recentDays(msId, maxDay, maxDay); // all played+scheduled days (for per-day view)
      if (!days.length) {
        log(`    · ${ev.slug} (${msId}): no widget matches yet`);
        continue;
      }
      const evMatches = [];
      // Keep every normalized match paired with the widget row it came from, so the
      // live overlays below can feed their findings back into a second pass.
      const pairs = [];
      for (const d of days) {
        estimateDay(d);
        for (const m of d.matches) {
          const norm = normalize(m, ev, msId, { n: d.day, label: d.dayDate });
          evMatches.push(norm);
          pairs.push({ raw: m, norm });
        }
      }
      // Overlay live points + serve onto the matches that are on court right now.
      // Never fails the event: a missing/HTML-changed board just leaves the OOP
      // set scores exactly as they were.
      let enriched = await applyLiveDetail(evMatches, msId, log);
      // Crionet's live board is EMPTY for events scored on Sporteaser instead, and
      // its order-of-play leaves an in-progress match blank until it completes - so
      // without this those events show every on-court match as upcoming with no
      // score. See adapters/sporteaser.js.
      enriched += await applySporteaserDetail(evMatches, ev, log);
      // estimateDay ran before the overlays, judging live-ness from the widget
      // alone — which on a Sporteaser-scored event means it saw nothing live, never
      // re-anchored to venue-now, and let the chain free-run from the court start.
      // Now that we know what is genuinely on court, re-chain the affected days.
      if (reestimate(days, pairs)) log(`    · re-estimated start times from live status`);
      out.push(...evMatches);
      log(`    ✓ ${ev.title} — day(s) ${days.map((d) => d.day).join(",")}: ${evMatches.length} matches${enriched ? ` (${enriched} live-detailed)` : ""}`);
    } catch (err) {
      log(`    ! ${ev.slug} failed — ${err.message}`);
    }
  }
  return out;
}

// ---- discovery -------------------------------------------------------------

async function discoverActiveEvents(date, log) {
  let events;
  try {
    const res = await fetch(`${WP}/events?orderby=modified&order=desc&per_page=40`, { headers: FIP_HEADERS });
    events = await res.json();
  } catch (err) {
    log(`  FIP: event discovery failed — ${err.message}`);
    return [];
  }
  const cutoff = shiftISO(date, -2); // "in play" = updated within ~2 days of target
  return (Array.isArray(events) ? events : [])
    .filter((e) => (e.modified || "").slice(0, 10) >= cutoff)
    .filter((e) => !/promis|promos/i.test(e.slug)) // FIP Promises (youth) have no widget feed
    .map((e) => ({
      slug: e.slug,
      link: e.link,
      title: decodeEntities(e.title?.rendered || e.slug),
      year: (e.slug.match(/-(\d{4})\b/) || [])[1] || String(new Date().getFullYear()),
    }));
}

async function matchscorerId(ev) {
  const res = await fetch(ev.link, { headers: FIP_HEADERS });
  const html = await res.text();
  const m = html.match(/idEvent[_-](\d+)/i);
  return m ? `FIP-${ev.year}-${m[1]}` : null;
}

// Scan day-by-day; return the last `windowN` non-empty days (≈ today's results +
// the next day's order-of-play), which is the useful "around now" window.
async function recentDays(msId, maxDay, windowN = 2) {
  const days = [];
  for (let day = 1; day <= maxDay; day++) {
    const res = await fetch(`${WIDGET}/oopbyday/${msId}/${day}?t=tol`, { headers: FIP_HEADERS });
    if (!res.ok) break;
    const { document } = parseHTML(await res.text());
    const parsed = parseWidget(document);
    if (parsed.matches.length) days.push({ day, now: parsed.now, dayDate: parsed.dayDate, matches: parsed.matches });
    else if (days.length) break; // first empty day after data -> stop
  }
  return days.slice(-windowN);
}

// ---- widget parsing (pure DOM parse over the fetched widget HTML) -----------

// The OOP widget groups matches by court (`.oop-court` header + `.oop-court-start`
// session time), each match table carrying its order-of-play phrase (`.court-name`:
// "Followed by" / "Not before 3:00 PM"), round, per-set cells, and a bottom
// `.live-status-summary` with duration + "Completed" for played matches. The page
// also exposes the venue-local clock and the active day's date — everything the
// per-court time estimator needs. `document` is a linkedom DOM built from the
// fetched widget HTML (same standard DOM API the browser gave us before).
function parseWidget(document) {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const now = (clean(document.body.textContent).match(/\d{1,2}\/\d{1,2}\/\d{4},?\s*\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?/i) || [])[0] || null;
  const dayDate = clean(document.querySelector(".play-day-button.active")?.textContent) || null;
  const out = [];
  let court = null, courtStart = null;
  for (const el of document.querySelectorAll(".oop-court, .oop-court-start, table")) {
    if (el.classList.contains("oop-court")) { court = clean(el.textContent); continue; }
    if (el.classList.contains("oop-court-start")) { courtStart = clean(el.textContent); continue; }
    const teamRows = [...el.querySelectorAll("tr")].filter((tr) => tr.querySelector("td.team"));
    if (teamRows.length < 2) continue;

    const schedule = clean(el.querySelector(".court-name")?.textContent);
    const round = clean(el.querySelector(".round-name")?.textContent);
    const summary = clean(el.querySelector(".live-status-summary")?.textContent);
    const durText = (summary.match(/(\d{1,2}:\d{2})/) || [])[1] || null;
    const summaryStatus = /completed/i.test(summary) ? "completed" : durText ? "live" : "";

    const teams = teamRows.slice(0, 2).map((tr) => ({
      players: [...tr.querySelectorAll(".double .line-thin")].map((e) => clean(e.textContent)).filter(Boolean),
      countries: [...tr.querySelectorAll(".double img.flags")].map(
        (im) => im.getAttribute("alt") || im.getAttribute("title") || (im.getAttribute("src") || "").split("/").pop()?.replace(/\.\w+$/, "") || null
      ),
      won: !!tr.querySelector(".winner"),
      setCells: [...tr.querySelectorAll("td.set")].map((td) => clean(td.textContent)),
    }));

    out.push({ court, courtStart, schedule, round, summaryStatus, durText, teams });
  }
  return { now, dayDate, matches: out };
}

// ---- live board (points + serve) -------------------------------------------

// One court block per in-play match. Points live in `td.points`; the serving
// side is the team whose cell contains the ball image. Warm-up blocks carry no
// points and no ball yet, which is exactly how they should render.
function parseLiveBoard(document) {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const out = [];
  for (const table of document.querySelectorAll("table")) {
    if (!table.querySelector("tr.scorebox-header-live")) continue;
    const teamRows = [...table.querySelectorAll("tr")].filter((tr) => tr.querySelector("td.team"));
    if (teamRows.length < 2) continue;
    const teams = teamRows.slice(0, 2).map((tr) => ({
      players: [...tr.querySelectorAll(".double .line-thin")].map((e) => clean(e.textContent)).filter(Boolean),
      points: clean(tr.querySelector("td.points")?.textContent) || null,
      serving: !!tr.querySelector("img.ballg"),
    }));
    const summary = clean(table.querySelector(".live-status-summary")?.textContent);
    out.push({ teams, warmup: /warm\s*up/i.test(summary) });
  }
  return out;
}

// Order-independent key over all four players, so a board and an OOP row match
// even if the two widgets list the sides (or the pair) in a different order.
// Seeding markers ("(5)") are stripped: they appear on the board but not always
// on the OOP row for the same pair.
const pkey = (names) =>
  (names || []).map((n) => String(n).replace(/\(\d+\)/g, "").toLowerCase().replace(/[^a-z]/g, "")).sort().join("+");
const boardKey = (sides) => sides.map(pkey).sort().join("~");

async function applyLiveDetail(matches, msId, log) {
  let boards;
  try {
    const res = await fetch(`${LIVE_BOARD}/${msId}?t=tol`, { headers: FIP_HEADERS });
    if (!res.ok) return 0;
    const { document } = parseHTML(await res.text());
    boards = parseLiveBoard(document);
  } catch (err) {
    log(`    · live board ${msId} skipped — ${err.message}`);
    return 0;
  }
  if (!boards?.length) return 0;

  const byKey = new Map();
  for (const b of boards) byKey.set(boardKey(b.teams.map((t) => t.players)), b);

  let n = 0;
  for (const m of matches) {
    const sides = m.teams.map((t) => t.players.map((p) => p.name));
    const b = byKey.get(boardKey(sides));
    if (!b) continue;
    // Align the board's sides to the match's sides before attaching anything —
    // getting this backwards would put the serve dot on the wrong pair.
    const flipped = pkey(b.teams[0].players) !== pkey(sides[0]);
    const [ta, tb] = flipped ? [b.teams[1], b.teams[0]] : b.teams;
    if (b.warmup) {
      m.score.warmup = true;
    } else {
      if (ta.points != null || tb.points != null) m.score.points = [ta.points ?? "", tb.points ?? ""];
      const side = ta.serving ? 0 : tb.serving ? 1 : null;
      if (side !== null) m.score.serving = side;
    }
    n++;
  }
  return n;
}

// Fallback live detail for events whose scoring is not on Crionet at all. Runs
// only for matches the board left without points, and only after discovery finds
// a sporteaser tournament for the event - most FIP events have none, which costs
// one cached lookup and nothing else.
async function applySporteaserDetail(matches, ev, log) {
  const pending = matches.filter((m) => m.status !== STATUS.FINAL && !m.score.points);
  if (!pending.length) return 0;
  const tid = await sporteaser.discoverTournamentId(ev.link, log);
  if (!tid) return 0;

  // Sporteaser is addressed by day-of-month; the widget's play-day label ("AUG 26")
  // is where that number comes from.
  const dayNums = [...new Set(pending.map((m) => sporteaser.dayOfMonth(m.day?.label)).filter(Boolean))];
  let n = 0;
  for (const d of dayNums) {
    const records = await sporteaser.fetchDay(tid, d, log);
    if (!records.length) continue;
    n += sporteaser.attach(matches.filter((m) => sporteaser.dayOfMonth(m.day?.label) === d), records, log);
  }
  if (n) log(`    sporteaser: ${n} match(es) live-detailed (tournament ${tid})`);
  return n;
}
// ---- time estimation (Node) ----------------------------------------------
// Estimate a venue-local start clock for each upcoming match by chaining per
// court: completed matches consume their ACTUAL duration, a live match is
// anchored to "now" + its remaining time, upcoming ones chain by an average,
// floored by any explicit "Not before" phrase. The now-anchor only applies on
// the day that is actually today (future days are the pure scheduled chain).
const AVG_MIN = 85, CHANGEOVER = 10, MIN_REMAIN = 12;
// Bounds on a measured turnover slot (match + changeover), so one freak day — an
// idle court, a retirement, a walkover — cannot drag the whole chain to an absurd
// pace in either direction.
const MIN_SLOT = 50, MAX_SLOT = 130;
// Where a court's chain starts when the order of play publishes no time at all.
const DEFAULT_START = 9 * 60;
const MON3 = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const parse12 = (s) => {
  const m = (s || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = +m[1]; const ap = (m[3] || "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return h * 60 + +m[2];
};
const durToMin = (s) => { const m = (s || "").match(/(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
const nowToMin = (s) => {
  const m = (s || "").match(/(\d{1,2}):(\d{2}):\d{2}\s*(AM|PM)?/i);
  if (!m) return null;
  let h = +m[1]; const ap = (m[3] || "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return h * 60 + +m[2];
};
// Clamp rather than wrap. A chain that over-ran midnight used to come back out of
// `% 1440` as "01:15" — which reads as EARLIER than now, and is worse than no
// estimate at all. Pinning it to 23:59 keeps the ordering honest.
const END_OF_DAY = 1439;
const fmtMin = (min) => {
  const v = Math.max(0, Math.min(END_OF_DAY, Math.round(min)));
  return String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(v % 60).padStart(2, "0");
};
function statusOf(m) {
  // Set by the second estimation pass (see fetchMatches) from what the live
  // overlays found. For a Sporteaser-scored event the widget itself never says
  // "live", so without this the chain below never re-anchors to real time.
  if (m.overlayStatus && m.overlayStatus !== STATUS.UPCOMING) return m.overlayStatus;
  if (m.summaryStatus === "completed" || m.teams[0]?.won || m.teams[1]?.won) return STATUS.FINAL;
  if (m.summaryStatus === "live") return STATUS.LIVE;
  const cells = [...(m.teams[0]?.setCells || []), ...(m.teams[1]?.setCells || [])];
  return cells.some((c) => c && c !== "-" && c !== "") ? STATUS.LIVE : STATUS.UPCOMING;
}
function isToday(dayDate, now) {
  const dm = (dayDate || "").match(/([A-Z]{3})\s+(\d{1,2})/i);
  const nd = (now || "").match(/(\d{1,2})\/(\d{1,2})\/\d{4}/); // M/D/Y (widget is US-format)
  return !!(dm && nd && MON3[dm[1].toUpperCase()] === +nd[1] && +dm[2] === +nd[2]);
}
// The widget's `.live-status-summary` carries a match duration on some events and
// only "Completed" on others — as of Aug 2026 none of the live FIP events expose
// one. With no durations the flat AVG_MIN charged every played match 95 minutes of
// court time; on a day of quick straight-setters that over-charges by ~25 min per
// match, and by mid-afternoon the chain is hours late. So measure the day's real
// pace instead: a court still in use has been busy since its start time, making
// elapsed-court-time / matches-played the actual slot length. A live match counts
// as half a slot (on average it is half done). Falls back to AVG_MIN on a future
// day, or when too little has been played to measure.
const clampSlot = (v) => Math.min(MAX_SLOT, Math.max(MIN_SLOT, v));

// A court still in use has been busy since its start time, so elapsed / played is
// its real turnover — match plus changeover, measured rather than assumed. Two
// completed matches is the minimum worth trusting: one tells you nothing, because
// a court that opened late looks identical to a court running a marathon. A live
// match counts as half a slot, being on average half done. Per COURT, not pooled
// across the day: courts keep very different paces (a Belgrade R32 day ran 70 min
// a slot on Court 1 and 116 on Court 4), and pooling them splits the difference
// and is wrong for both.
function courtSlot(ms, N, start) {
  if (N == null || start == null) return null;
  if (!ms.some((m) => statusOf(m) !== STATUS.FINAL)) return null; // done for the day
  // Measure across an unbroken run of "Followed by" play only. An explicit "Not
  // before 11:45 AM" means the court deliberately sat idle until then, and
  // charging that gap to the matches makes the court look far slower than it is:
  // Belgrade Court 4 measured 117 min a slot against a true ~88, purely on one
  // scheduled gap. Re-anchor on the last such marker and measure from there.
  let anchor = start, from = 0;
  for (let i = 0; i < ms.length; i++) {
    if (statusOf(ms[i]) !== STATUS.FINAL) break;
    const t = parse12(ms[i].schedule);
    if (t != null && /not before|starting at/i.test(ms[i].schedule)) { anchor = t; from = i; }
  }
  const done = ms.slice(from).filter((m) => statusOf(m) === STATUS.FINAL).length;
  if (done < 2 || N - anchor <= 0) return null;
  return clampSlot((N - anchor) / (done + (ms.some((m) => statusOf(m) === STATUS.LIVE) ? 0.5 : 0)));
}

// Median of the courts that had enough played to measure — the pace a court with
// no evidence of its own inherits. Falls back to the old flat assumption.
function daySlot(byCourt, N) {
  const v = [];
  for (const ms of byCourt.values()) {
    const s = courtSlot(ms, N, parse12(ms[0].courtStart) ?? parse12(ms[0].schedule) ?? DEFAULT_START);
    if (s != null) v.push(s);
  }
  if (!v.length) return AVG_MIN + CHANGEOVER;
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

// Feed the overlays' verdict back into the chain and recompute. Only runs when
// the live picture actually changed, so events whose widget was already telling
// the truth cost nothing.
function reestimate(days, pairs) {
  let changed = false;
  for (const { raw, norm } of pairs) {
    if (norm.status !== statusOf(raw)) { raw.overlayStatus = norm.status; changed = true; }
  }
  if (!changed) return false;
  for (const d of days) estimateDay(d);
  for (const { raw, norm } of pairs) {
    const upcoming = statusOf(raw) === STATUS.UPCOMING;
    norm.estStart = upcoming ? raw.estStart || null : null;
    norm.estStartAt = upcoming ? raw.estStartAt || null : null;
  }
  return true;
}

function estimateDay(day) {
  const N = isToday(day.dayDate, day.now) ? nowToMin(day.now) : null;
  const byCourt = new Map();
  for (const m of day.matches) {
    const c = m.court || "?";
    if (!byCourt.has(c)) byCourt.set(c, []);
    byCourt.get(c).push(m);
  }
  const fallbackSlot = daySlot(byCourt, N);
  for (const ms of byCourt.values()) {
    // Falling back to N here would anchor a day that has not begun to the current
    // clock: pulling tomorrow's order of play at 01:32 venue-time produced a Round
    // of 32 "starting" at 01:32. A day with no published time starts at 09:00.
    const courtStart = parse12(ms[0].courtStart) ?? parse12(ms[0].schedule) ?? DEFAULT_START;
    // Only trust the venue clock once play is due to be under way. Before the day's
    // start time, "now" says nothing about when these matches go on.
    const underway = N != null && N >= courtStart;
    const slot = courtSlot(ms, N, courtStart) ?? fallbackSlot; // wall-clock, changeover included
    let running = courtStart;
    // The queue has not been anchored to real time yet. Until it is, the chain is
    // pure arithmetic over the scheduled order and can drift from what the court
    // is actually doing.
    let floating = true;
    for (const m of ms) {
      const st = statusOf(m);
      if (st === STATUS.FINAL) {
        running += durToMin(m.durText) != null ? durToMin(m.durText) + CHANGEOVER : slot;
      } else if (st === STATUS.LIVE) {
        running = (N != null ? N : running) + Math.max(MIN_REMAIN, slot - CHANGEOVER - (durToMin(m.durText) ?? (slot - CHANGEOVER) / 2)) + CHANGEOVER;
        floating = false; // anchored: the rest of this court queues behind a real match
      } else {
        let est = running;
        // First match still to play on a court already in session: every match
        // before it has FINISHED, so it is on court now or about to be — whatever
        // the chain of assumed durations added up to. Snapping here is what stops
        // the drift; the old code only floored at now, so an over-long chain (95
        // min charged per match, on a day really running 70) sailed past it and
        // came out hours late.
        if (underway && floating) est = N;
        else if (underway) est = Math.max(est, N);
        floating = false;
        const t = parse12(m.schedule);
        if (t != null && /not before|starting at/i.test(m.schedule)) est = Math.max(est, t);
        m.estStart = fmtMin(est);
        // absolute timestamp (only meaningful today, where venue-now anchors real
        // time) — powers the "starting soon" pre-alert without any timezone data.
        if (N != null) m.estStartAt = new Date(Date.now() + (est - N) * 60000).toISOString();
        running = est + slot;
      }
    }
  }
}

// ---- normalization ---------------------------------------------------------

function normalize(m, ev, msId, day) {
  const [a, b] = m.teams;
  // pair the two teams' game cells into per-set [teamA, teamB], dropping "-" (unplayed)
  const nSets = Math.max(a.setCells.length, b.setCells.length);
  const sets = [];
  for (let i = 0; i < nSets; i++) {
    const x = a.setCells[i], y = b.setCells[i];
    if ((x && x !== "-") || (y && y !== "-")) sets.push([x === "-" ? "" : x || "", y === "-" ? "" : y || ""]);
  }
  return {
    id: gid("fip", `${msId}:${sig(a, b, m.round)}`),
    source: "fip",
    federation: "FIP",
    tournament: { id: msId, name: ev.title, url: ev.link },
    className: null,
    round: m.round || null,
    day: day || null,                 // { n, label } tournament play-day, for per-day grouping
    court: m.court || null,           // real court (CENTER COURT / COURT 2 …)
    schedule: m.schedule || null,     // order-of-play phrase ("Not before 3:00 PM")
    estStart: statusOf(m) === STATUS.UPCOMING ? m.estStart || null : null, // venue-local "HH:MM"
    estStartAt: statusOf(m) === STATUS.UPCOMING ? m.estStartAt || null : null, // absolute ISO (today only)
    status: statusOf(m),
    startTime: null, // no full datetime in the widget; schedule/estStart carry timing
    teams: [team(a), team(b)],
    score: { sets, winner: a.won ? 0 : b.won ? 1 : null },
    raw: { summaryStatus: m.summaryStatus, dur: m.durText },
  };
}

const team = (t) => ({
  name: (t.players || []).join(" / ") || "TBD",
  players: (t.players || []).map((p, i) => ({ name: p, country: (t.countries || [])[i] || null })),
});

const sig = (a, b, round) =>
  [a.players?.join("+"), b.players?.join("+"), round].join("|").replace(/\s+/g, "");

// ---- helpers ---------------------------------------------------------------

function shiftISO(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function decodeEntities(s) {
  return String(s)
    .replace(/&#8211;/g, "–").replace(/&#038;|&amp;/g, "&")
    .replace(/&#8217;/g, "’").replace(/&hellip;/g, "…").replace(/&nbsp;/g, " ").trim();
}
