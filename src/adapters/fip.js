// FIP / Premier Padel adapter. The pro tour's match data is NOT in padelfip.com
// HTML — it's in an embedded matchscorerlive widget (server-rendered HTML).
// Method (per the DPK padel-db work):
//   1. discover in-play tournaments via padelfip WordPress REST (recent `modified`)
//   2. read each event page for its `idEvent` -> matchscorer id `FIP-{year}-{idEvent}`
//   3. fetch the current day's Order-of-Play widget (completed + live + upcoming)
//   4. parse the widget HTML (via the shared browser's setContent) -> normalize
//
// The widget 403s without a browser UA + `Referer: padelfip.com`.

import { withPage } from "../browser.js";
import { STATUS, gid } from "../schema.js";

export const id = "fip";

const FIP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Referer: "https://www.padelfip.com/",
  Accept: "text/html,application/json",
};
const WIDGET = "https://widget.matchscorerlive.com/screen";
const WP = "https://www.padelfip.com/wp-json/wp/v2";

export async function fetchMatches({ date = todayISO(), maxTournaments = 15, maxDay = 9, log = () => {} } = {}) {
  const events = await discoverActiveEvents(date, log);
  const active = events.slice(0, maxTournaments);
  log(`  FIP: ${active.length} pro-tour tournament(s) in play around ${date}`);
  if (!active.length) return [];

  const out = [];
  await withPage(async (page) => {
    // don't waste time loading widget images/css when we only read the DOM
    await page.route("**/*", (r) =>
      ["image", "stylesheet", "font", "media"].includes(r.request().resourceType()) ? r.abort() : r.continue()
    );

    for (const ev of active) {
      try {
        const msId = await matchscorerId(ev);
        if (!msId) {
          log(`    ! ${ev.slug}: no idEvent on event page`);
          continue;
        }
        const days = await recentDays(page, msId, maxDay, maxDay); // all played+scheduled days (for per-day view)
        if (!days.length) {
          log(`    · ${ev.slug} (${msId}): no widget matches yet`);
          continue;
        }
        let n = 0;
        for (const d of days) { estimateDay(d); for (const m of d.matches) { out.push(normalize(m, ev, msId, { n: d.day, label: d.dayDate })); n++; } }
        log(`    ✓ ${ev.title} — day(s) ${days.map((d) => d.day).join(",")}: ${n} matches`);
      } catch (err) {
        log(`    ! ${ev.slug} failed — ${err.message}`);
      }
    }
  });
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
async function recentDays(page, msId, maxDay, windowN = 2) {
  const days = [];
  for (let day = 1; day <= maxDay; day++) {
    const res = await fetch(`${WIDGET}/oopbyday/${msId}/${day}?t=tol`, { headers: FIP_HEADERS });
    if (!res.ok) break;
    await page.setContent(await res.text(), { waitUntil: "domcontentloaded" });
    const parsed = await page.evaluate(parseWidget);
    if (parsed.matches.length) days.push({ day, now: parsed.now, dayDate: parsed.dayDate, matches: parsed.matches });
    else if (days.length) break; // first empty day after data -> stop
  }
  return days.slice(-windowN);
}

// ---- widget parsing (runs in the page) -------------------------------------

// The OOP widget groups matches by court (`.oop-court` header + `.oop-court-start`
// session time), each match table carrying its order-of-play phrase (`.court-name`:
// "Followed by" / "Not before 3:00 PM"), round, per-set cells, and a bottom
// `.live-status-summary` with duration + "Completed" for played matches. The page
// also exposes the venue-local clock and the active day's date — everything the
// per-court time estimator needs.
function parseWidget() {
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

// ---- time estimation (Node) ----------------------------------------------
// Estimate a venue-local start clock for each upcoming match by chaining per
// court: completed matches consume their ACTUAL duration, a live match is
// anchored to "now" + its remaining time, upcoming ones chain by an average,
// floored by any explicit "Not before" phrase. The now-anchor only applies on
// the day that is actually today (future days are the pure scheduled chain).
const AVG_MIN = 85, CHANGEOVER = 10, MIN_REMAIN = 12;
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
const fmtMin = (min) => String(Math.floor((min % 1440) / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
function statusOf(m) {
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
function estimateDay(day) {
  const N = isToday(day.dayDate, day.now) ? nowToMin(day.now) : null;
  const byCourt = new Map();
  for (const m of day.matches) {
    const c = m.court || "?";
    if (!byCourt.has(c)) byCourt.set(c, []);
    byCourt.get(c).push(m);
  }
  for (const ms of byCourt.values()) {
    let running = parse12(ms[0].courtStart) ?? parse12(ms[0].schedule) ?? N ?? 540;
    for (const m of ms) {
      const st = statusOf(m);
      if (st === STATUS.FINAL) {
        running += (durToMin(m.durText) || AVG_MIN) + CHANGEOVER;
      } else if (st === STATUS.LIVE) {
        running = (N != null ? N : running) + Math.max(MIN_REMAIN, AVG_MIN - (durToMin(m.durText) || AVG_MIN / 2)) + CHANGEOVER;
      } else {
        let est = running;
        if (N != null) est = Math.max(est, N);
        const t = parse12(m.schedule);
        if (t != null && /not before|starting at/i.test(m.schedule)) est = Math.max(est, t);
        m.estStart = fmtMin(est);
        // absolute timestamp (only meaningful today, where venue-now anchors real
        // time) — powers the "starting soon" pre-alert without any timezone data.
        if (N != null) m.estStartAt = new Date(Date.now() + (est - N) * 60000).toISOString();
        running = est + AVG_MIN + CHANGEOVER;
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
