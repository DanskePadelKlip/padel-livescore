// tournamentsoftware.com adapter (Norway = ntf, GB = LTA instance). This platform
// is a real live-scoring tournament system (unlike Padelution, which only
// publishes standings). Data is AJAX-rendered behind a cookiewall, so we drive it
// through the shared Playwright layer.
//
// Multiple national instances share IDENTICAL DOM markup; they differ only in the
// LANGUAGE of dates (Norwegian vs English month names) and the cookiewall button.
// Each instance carries a `locale` and everything language-specific is keyed off
// LOCALES below — adding another country's instance means adding a row (+ a locale
// if it's a new language), not a new adapter.
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

// Month-name -> number, per language. Keys include full + common abbreviations so
// both "12 July 2026" and "12 Jul 2026" (and the Norwegian equivalents) parse.
const LOCALES = {
  no: {
    months: {
      januar: 1, februar: 2, mars: 3, april: 4, mai: 5, juni: 6, juli: 7,
      august: 8, september: 9, oktober: 10, november: 11, desember: 12,
      jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9,
      sept: 9, okt: 10, nov: 11, des: 12,
    },
  },
  en: {
    months: {
      january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
      august: 8, september: 9, october: 10, november: 11, december: 12,
      jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9,
      sept: 9, oct: 10, nov: 11, dec: 12,
    },
  },
};

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
      const months = (LOCALES[inst.locale] || LOCALES.en).months;
      await clearCookiewall(page, inst.base);
      const tournaments = await discoverTournaments(page, inst.base, months);
      const winLo = shiftDay(date, -DAY_BACK), winHi = shiftDay(date, DAY_FWD);
      const active = tournaments.filter((t) => overlapsWindow(t, winLo, winHi)).slice(0, maxTournaments);
      log(`  ${inst.code}: ${active.length}/${tournaments.length} padel tournaments in ${winLo}..${winHi}`);

      for (const t of active) {
        try {
          // t.start is already ISO (yyyy-mm-dd); its year seeds match dates when a
          // day heading omits the year.
          const fallbackYear = (t.start || "").slice(0, 4) || String(new Date().getFullYear());
          const raw = await scrapeMatches(page, inst.base, t.guid, fallbackYear, months, date);
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
  // LTA uses a OneTrust banner whose accept button has a stable id — try it first.
  const ot = page.locator("#onetrust-accept-btn-handler").first();
  if (await ot.count()) await ot.click().catch(() => {});
  for (const label of ["Godta alle", "Godta", "Aksepter", "Accept all", "Allow all", "I Accept", "Accept", "OK"]) {
    const b = page.getByRole("button", { name: label, exact: false }).first();
    if (await b.count()) {
      await b.click().catch(() => {});
      break;
    }
  }
  await page.waitForTimeout(800);
}

async function discoverTournaments(page, base, months) {
  await page.goto(base + "/find/tournament?q=padel", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  // Extract guid/title/rawtext in the page; parse dates in Node (locale-aware).
  const cards = await page.evaluate(() => {
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
      const title = (card?.querySelector(".media__title")?.innerText || a.innerText || "")
        .trim()
        .replace(/([^\d\s])(\d{4})$/, "$1 $2"); // un-glue trailing year: "...Liga2026" -> "...Liga 2026"
      out.push({ guid, title, text });
    }
    return out;
  });
  return cards.map((c) => {
    const dates = parseDateRange(c.text, months); // [startISO, endISO] | []
    return {
      guid: c.guid,
      name: c.title || c.text.slice(0, 60),
      start: dates[0] || null, // yyyy-mm-dd
      end: dates[1] || dates[0] || null,
    };
  });
}

// Parse the first two date tokens from a card's text into ISO, regardless of
// format: numeric dd.mm.yyyy / dd/mm/yyyy (NO uses dots, LTA uses slashes) or a
// month-name form ("12 July 2026"). Returns [] if none found.
function parseDateRange(text, months) {
  const iso = [];
  const numeric = /\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g; // dd.mm.yyyy | dd/mm/yyyy
  let m;
  while ((m = numeric.exec(text)) && iso.length < 2) {
    iso.push(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  }
  if (iso.length) return iso;
  const monthAlt = Object.keys(months).sort((a, b) => b.length - a.length).join("|");
  const named = new RegExp(`\\b(\\d{1,2})\\s+(${monthAlt})\\.?\\s+(\\d{4})\\b`, "gi");
  while ((m = named.exec(text)) && iso.length < 2) {
    const mm = months[m[2].toLowerCase()];
    if (mm) iso.push(`${m[3]}-${String(mm).padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  }
  return iso;
}

// How many days around the target date to scrape per tournament, and a hard cap.
// The Matches page shows ONE day and defaults to "today" — which for an in-progress
// event is frequently NOT a play day, so the old single-page scrape saw an empty
// grid and the tournament yielded nothing (this is why GB/LTA looked dead: its
// events' matches live on their real play days, reachable only via the day nav).
const DAY_BACK = 4, DAY_FWD = 7, MAX_DAYS = 12;

// Shift an ISO date by n days, tz-safe: anchor at noon UTC and move UTC date parts
// so the result never drifts across a day boundary on machines offset from UTC.
const shiftDay = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function scrapeMatches(page, base, guid, fallbackYear, months, date) {
  await page.goto(`${base}/tournament/${guid}/Matches`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  // Each day tab is a real URL: /tournament/{guid}/matches/YYYYMMDD (data-value).
  const navDays = await page.evaluate(() =>
    [...document.querySelectorAll(".js-date-selection-tab[data-value]")]
      .map((a) => a.getAttribute("data-value"))
      .filter((v) => /^\d{8}$/.test(v))
  );
  // No navigator = a single-day event; the default page IS that day.
  if (!navDays.length) return extractDay(page, months, fallbackYear, null);
  // Scrape only real play days within a tight window around the target date,
  // bounded so a long league doesn't explode the scrape.
  const lo = shiftDay(date, -DAY_BACK), hi = shiftDay(date, DAY_FWD);
  const want = [...new Set(navDays)]
    .map((v) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`)
    .filter((iso) => iso >= lo && iso <= hi)
    .sort()
    .slice(0, MAX_DAYS);
  const all = [];
  for (const iso of want) {
    await page.goto(`${base}/tournament/${guid}/matches/${iso.replace(/-/g, "")}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    all.push(...(await extractDay(page, months, fallbackYear, iso)));
  }
  return all;
}

// Extract match rows from whatever day the Matches page is currently showing.
// `forceDate` (ISO) is the known day when we navigated to a dated URL; otherwise
// the day is read from the page heading (year optional -> tournament fallback).
function extractDay(page, months, fallbackYear, forceDate) {
  return page.evaluate(({ MONTHS, fallbackYear, forceDate }) => {
    const monthAlt = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
    let pageDate = forceDate || null;
    if (!pageDate) {
      const dm = document.body.innerText.match(
        new RegExp(`(\\d{1,2})\\.?\\s+(${monthAlt})\\.?(?:\\s+(\\d{4}))?`, "i")
      );
      if (dm && MONTHS[dm[2].toLowerCase()]) {
        const year = dm[3] || fallbackYear;
        pageDate = `${year}-${String(MONTHS[dm[2].toLowerCase()]).padStart(2, "0")}-${String(+dm[1]).padStart(2, "0")}`;
      } else {
        const nm = document.body.innerText.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/);
        if (nm) pageDate = `${nm[3]}-${nm[2].padStart(2, "0")}-${nm[1].padStart(2, "0")}`;
      }
    }
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
        // A real match has exactly two teams. The grid view (vs the list view)
        // renders a whole match-group as ONE flattened item — many teams + all
        // their points concatenated — which would otherwise surface as a bogus
        // >3-set line. Skip those; the list view carries each match cleanly.
        if (teams.length !== 2) continue;
        rows.push({ date: pageDate, header, time, teams, sets });
      }
    }
    return rows;
  }, { MONTHS: months, fallbackYear, forceDate });
}

// ---- shaping ---------------------------------------------------------------

// Grid view + list view both render .match-group__item, so every match appears
// (at least) twice. Collapse to one row per match, keeping the most complete
// REAL score. We key on header+teams only (NOT sets/time): the two views can
// disagree on the score because the LTA grid view sometimes over-captures
// .points cells from neighbouring matches, yielding impossible >3-set lines
// (padel is best-of-3, championship tie-break shown as a 3rd set). Ranking
// prefers the variant with the most sets that is still ≤3, so the clean
// list-view score wins over the over-captured grid one.
//   Trade-off: a genuine rematch of the same pairing in the same round would
//   collapse to one row — but knockout/round-robin formats never rematch the
//   same pair under the same header, so this doesn't happen in practice.
function dedupe(rows) {
  const key = (r) => JSON.stringify([r.header, r.teams.map((t) => t.players)]);
  const rank = (r) => (r.sets.length <= 3 ? r.sets.length : -r.sets.length);
  const best = new Map();
  for (const r of rows) {
    const k = key(r);
    const cur = best.get(k);
    if (!cur || rank(r) > rank(cur)) best.set(k, r);
  }
  return [...best.values()];
}

function normalize(m, t, inst) {
  const [a, b] = m.teams.length === 2 ? m.teams : [m.teams[0] || { players: [] }, m.teams[1] || { players: [] }];
  const round = (m.header.match(/\b(Round|Runde|Final(?:e)?|Semi\w*|Quarter\w*|Kvart\w*)\b.*$/i) || [])[0] || null;
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
    teams: [team(a, inst.code), team(b, inst.code)],
    score: { sets: m.sets, winner: a.won ? 0 : b.won ? 1 : null },
    raw: { header: m.header, time: m.time },
  };
}

const team = (t, country) => ({
  name: (t.players || []).map(cleanPlayer).join(" / ") || "TBD",
  players: (t.players || []).map((p) => ({ name: cleanPlayer(p), country })),
});

// strip display noise: the "(C)" captain marker (NO) and trailing seeding/entry
// tags the LTA appends to names, e.g. "Kace Bartley [1, DA]" -> "Kace Bartley".
const cleanPlayer = (p) => p.replace(/\s*\[[^\]]*\]\s*$/, "").replace(/\s*\(C\)\s*$/, "").trim();

const sig = (a, b, m) =>
  [a.players?.join("+"), b.players?.join("+"), m.header, JSON.stringify(m.sets)].join("|").replace(/\s+/g, "");

// Select a tournament if its date range overlaps the scrape window [lo, hi]
// (recent finals + in-progress + imminent), so the day strip shows the last few
// days and the next few — not only events live on the literal target day. A
// weekend event that finished yesterday still surfaces its results. Dates are ISO
// (yyyy-mm-dd), so lexical comparison is chronological.
function overlapsWindow(t, lo, hi) {
  const s = t.start, e = t.end || t.start;
  if (!s) return false;
  return s <= hi && e >= lo;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
