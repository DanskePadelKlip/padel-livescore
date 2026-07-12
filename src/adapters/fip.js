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
        const days = await recentDays(page, msId, maxDay);
        if (!days.length) {
          log(`    · ${ev.slug} (${msId}): no widget matches yet`);
          continue;
        }
        let n = 0;
        for (const d of days) for (const m of d.matches) { out.push(normalize(m, ev, msId)); n++; }
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
    const matches = await page.evaluate(parseWidget);
    if (matches.length) days.push({ day, matches });
    else if (days.length) break; // first empty day after data -> stop
  }
  return days.slice(-windowN);
}

// ---- widget parsing (runs in the page) -------------------------------------

function parseWidget() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const out = [];
  for (const table of document.querySelectorAll("table")) {
    const teamRows = [...table.querySelectorAll("tr")].filter((tr) => tr.querySelector("td.team"));
    if (teamRows.length < 2) continue;

    const header = table.querySelector('[class*="scorebox-header-"]');
    const statusCls = header ? ([...header.classList].find((c) => c.startsWith("scorebox-header-")) || "") : "";
    const court = clean(table.querySelector(".court-name")?.textContent);
    const round = clean(table.querySelector(".round-name")?.textContent);

    const teams = teamRows.slice(0, 2).map((tr) => ({
      players: [...tr.querySelectorAll(".double .line-thin")].map((e) => clean(e.textContent)).filter(Boolean),
      countries: [...tr.querySelectorAll(".double img.flags")].map(
        (im) => im.getAttribute("alt") || im.getAttribute("title") || (im.getAttribute("src") || "").split("/").pop()?.replace(/\.\w+$/, "") || null
      ),
      won: !!tr.querySelector(".winner"),
      setCells: [...tr.querySelectorAll("td.set")].map((td) => clean(td.textContent)),
    }));

    out.push({ status: statusCls.replace("scorebox-header-", ""), court, round, teams });
  }
  return out;
}

// ---- normalization ---------------------------------------------------------

function normalize(m, ev, msId) {
  const [a, b] = m.teams;
  // pair the two teams' game cells into per-set [teamA, teamB], dropping "-" (unplayed)
  const nSets = Math.max(a.setCells.length, b.setCells.length);
  const sets = [];
  for (let i = 0; i < nSets; i++) {
    const x = a.setCells[i], y = b.setCells[i];
    if ((x && x !== "-") || (y && y !== "-")) sets.push([x === "-" ? "" : x || "", y === "-" ? "" : y || ""]);
  }
  const status = mapStatus(m.status, sets, a.won || b.won);
  // for not-yet-played matches the widget puts a schedule phrase where the court
  // goes ("Starting at 9:00 AM" / "Followed by") — that's not a court.
  const isSchedule = /starting at|followed by|not before|after rest|to follow/i.test(m.court || "");
  return {
    id: gid("fip", `${msId}:${sig(a, b, m.round)}`),
    source: "fip",
    federation: "FIP",
    tournament: { id: msId, name: ev.title, url: ev.link },
    className: null,
    round: m.round || null,
    court: isSchedule ? null : m.court || null,
    status,
    startTime: null, // widget gives "Starting at 10:00 AM" text (kept in court), not a full datetime
    teams: [team(a), team(b)],
    score: { sets, winner: a.won ? 0 : b.won ? 1 : null },
    raw: { status: m.status },
  };
}

// The widget's header class ("...-completed") is an unreliable per-match signal
// (scheduled matches also carry it), so derive status from the data: a decided
// winner = final; partial scores with no winner = live; nothing yet = upcoming.
function mapStatus(widgetStatus, sets, decided) {
  if (decided) return STATUS.FINAL;
  if (/live|progress/i.test(widgetStatus)) return STATUS.LIVE;
  const hasScore = sets.some((s) => (s[0] && s[0] !== "") || (s[1] && s[1] !== ""));
  return hasScore ? STATUS.LIVE : STATUS.UPCOMING;
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
