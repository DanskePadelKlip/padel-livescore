// tournamentsoftware.com adapter (Norway = ntf instance). This platform is a
// real live-scoring tournament system (unlike Padelution, which only publishes
// standings). Data is AJAX-rendered behind a cookiewall, so we drive it through
// the shared Playwright layer.
//
// Flow per instance:
//   1. clear the cookiewall once
//   2. /find/tournament?q=padel        -> padel tournaments (guid, name, dates)
//   3. keep tournaments active on the target day
//   4. /tournament/{guid}/Matches      -> match rows (dedup grid+list duplicates)
//   5. normalize -> NormalizedMatch

import { withPage } from "../browser.js";
import { TOURNAMENTSOFTWARE_INSTANCES } from "../federations.js";
import { STATUS, gid } from "../schema.js";

export const id = "tournamentsoftware";

export async function fetchMatches({
  date = todayISO(),
  instances = TOURNAMENTSOFTWARE_INSTANCES,
  maxTournaments = 12,
  log = () => {},
} = {}) {
  const out = [];
  // NB: browser is closed centrally by aggregate() (shared with the fip adapter).
  await withPage(async (page) => {
    for (const inst of instances) {
      await clearCookiewall(page, inst.base);
      const tournaments = await discoverTournaments(page, inst.base);
      const active = tournaments.filter((t) => coversDay(t, date)).slice(0, maxTournaments);
      log(`  ${inst.code}: ${active.length}/${tournaments.length} padel tournaments active on ${date}`);

      for (const t of active) {
        try {
          const fallbackYear = (t.start || "").slice(6, 10) || String(new Date().getFullYear());
          const raw = await scrapeMatches(page, inst.base, t.guid, fallbackYear);
          for (const m of dedupe(raw)) out.push(normalize(m, t, inst));
        } catch (err) {
          log(`    ! tournament ${t.guid} (${t.name}) failed — ${err.message}`);
        }
      }
    }
  });
  return out;
}

// ---- browser steps ---------------------------------------------------------

async function clearCookiewall(page, base) {
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  for (const label of ["Godta alle", "Godta", "Aksepter", "Accept all", "Accept", "OK"]) {
    const b = page.getByRole("button", { name: label, exact: false }).first();
    if (await b.count()) {
      await b.click().catch(() => {});
      break;
    }
  }
  await page.waitForTimeout(800);
}

async function discoverTournaments(page, base) {
  await page.goto(base + "/find/tournament?q=padel", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="/sport/tournament?id="]')];
    const seen = new Set();
    const out = [];
    for (const a of links) {
      const m = a.getAttribute("href").match(/id=([A-Fa-f0-9-]{8,})/);
      if (!m) continue;
      const guid = m[1].toLowerCase();
      if (seen.has(guid)) continue;
      seen.add(guid);
      const card = a.closest("li,article,.media,div");
      const text = (card?.innerText || a.innerText || "").replace(/\s+/g, " ").trim();
      const dates = text.match(/(\d{2}\.\d{2}\.\d{4}).*?(\d{2}\.\d{2}\.\d{4})/);
      // the title link wraps the whole card; the title is its first line
      const title = (card?.querySelector(".media__title")?.innerText || a.innerText || "")
        .trim()
        .replace(/([^\d\s])(\d{4})$/, "$1 $2"); // un-glue trailing year: "...Liga2026" -> "...Liga 2026"
      out.push({
        guid,
        name: title || text.slice(0, 60),
        start: dates?.[1] || null, // dd.mm.yyyy
        end: dates?.[2] || dates?.[1] || null,
      });
    }
    return out;
  });
}

async function scrapeMatches(page, base, guid, fallbackYear) {
  await page.goto(`${base}/tournament/${guid}/Matches`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  return page.evaluate((fallbackYear) => {
    const MONTHS = { januar: 1, februar: 2, mars: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, desember: 12 };
    const parseNorDate = (txt) => {
      const m = (txt || "").match(/(\d{1,2})\.?\s+([a-zæøå]+)(?:\s+(\d{4}))?/i);
      if (!m || !MONTHS[m[2].toLowerCase()]) return null;
      const year = m[3] || fallbackYear;
      if (!year) return null;
      return `${year}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
    };
    // The Matches page shows one day; .match-group__header holds only the
    // time-of-day. The selected day appears in the heading in dotted form WITH a
    // year ("21. juni 2026"); the day-navigator items omit the year, so matching
    // "<n>. <month> <yyyy>" uniquely picks the heading.
    let pageDate = null;
    const dm = document.body.innerText.match(
      /(\d{1,2})\.\s+(januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)\s+(\d{4})/i
    );
    if (dm) pageDate = `${dm[3]}-${String(MONTHS[dm[2].toLowerCase()]).padStart(2, "0")}-${String(+dm[1]).padStart(2, "0")}`;
    const rows = [];
    for (const group of document.querySelectorAll(".match-group")) {
      const groupTime = ((group.querySelector(".match-group__header")?.innerText || "").match(/\d{1,2}:\d{2}/) || [])[0] || null;
      for (const item of group.querySelectorAll(".match-group__item")) {
        const header = item.querySelector(".match__header-title")?.innerText.replace(/\s+/g, " ").trim() || "";
        const time = groupTime || (item.innerText.match(/\b(\d{1,2}:\d{2})\b/) || [])[1] || null;
        const teams = [...item.querySelectorAll(".match__row")].map((r) => ({
          players: [...r.querySelectorAll(".match__row-title-value-content")].map((p) => p.innerText.trim()).filter(Boolean),
          won: r.classList.contains("has-won"),
        }));
        // sets: each ul.points is a set; li[0]=teamA games, li[1]=teamB games
        const sets = [...item.querySelectorAll(".match__result .points")].map((ul) => {
          const cells = [...ul.querySelectorAll(".points__cell")].map((c) => c.textContent.trim());
          return [cells[0] ?? "", cells[1] ?? ""];
        }).filter((s) => s[0] !== "" || s[1] !== "");
        rows.push({ date: pageDate, header, time, teams, sets });
      }
    }
    return rows;
  }, fallbackYear);
}

// ---- shaping ---------------------------------------------------------------

// Grid view + list view both render .match-group__item, so identical matches
// appear twice. Dedupe on a content signature.
function dedupe(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    // NB: exclude time — grid view carries it, list view doesn't, but it's the
    // same match. Sets distinguish genuine rematches of the same pairing.
    const sig = JSON.stringify([r.header, r.teams.map((t) => t.players), r.sets]);
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

function normalize(m, t, inst) {
  const [a, b] = m.teams.length === 2 ? m.teams : [m.teams[0] || { players: [] }, m.teams[1] || { players: [] }];
  const round = (m.header.match(/\b(Round|Runde|Final(?:e)?|Semi\w*|Kvart\w*)\b.*$/i) || [])[0] || null;
  const className = round ? m.header.replace(round, "").trim() : m.header;
  const hasScore = m.sets.length > 0;
  const decided = a.won || b.won;
  return {
    id: gid("ts", `${t.guid}:${sig(a, b, m)}`),
    source: "tournamentsoftware",
    federation: inst.code,
    tournament: { id: t.guid, name: t.name, url: `${inst.base}/sport/tournament?id=${t.guid}` },
    className: className || null,
    round,
    court: null,
    status: decided ? STATUS.FINAL : hasScore ? STATUS.LIVE : STATUS.UPCOMING,
    startTime: m.date ? `${m.date}T${m.time || "00:00"}:00` : null,
    teams: [team(a), team(b)],
    score: { sets: m.sets, winner: a.won ? 0 : b.won ? 1 : null },
    raw: { header: m.header, time: m.time },
  };
}

const team = (t) => ({
  name: (t.players || []).map(cleanPlayer).join(" / ") || "TBD",
  players: (t.players || []).map((p) => ({ name: cleanPlayer(p), country: "NO" })),
});

// strip the "(C)" captain marker for display
const cleanPlayer = (p) => p.replace(/\s*\(C\)\s*$/, "").trim();

const sig = (a, b, m) =>
  [a.players?.join("+"), b.players?.join("+"), m.header, JSON.stringify(m.sets)].join("|").replace(/\s+/g, "");

function coversDay(t, day) {
  const toISO = (d) => (d ? d.split(".").reverse().join("-") : null); // dd.mm.yyyy -> yyyy-mm-dd
  const s = toISO(t.start);
  const e = toISO(t.end) || s;
  if (!s) return false;
  return s <= day && day <= e;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
