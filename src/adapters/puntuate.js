// Puntuate — FIP's CHAMPIONSHIP scoring platform (national-team events).
//
// The tour runs on matchscorerlive (see adapters/fip.js); FIP championships do
// not. The World Cup qualifiers are served by postafip.puntuate.com, which
// padelfip.com embeds in its Live Score and Order of Play tabs. Two views:
//
//   ordenJuegoFip.aspx?idTorneo=<id>&rf=0             today's order of play
//   ordenJuegoFip.aspx?idTorneo=<id>&rf=0&enjuego=1   only what is on court now
//
// `rf=<seconds>` is that page's own auto-refresh interval, NOT a tab, and there
// is no date parameter: the server always serves the current day. So this
// adapter can only ever see today, which is all a livescore needs.
//
// THE UNIT IS THE TIE, not the match. A national tie is three matches between
// the same two countries and the sheet repeats the nations on every row with the
// TIE score ("BGR 0 - 0 GRC"), not a per-match game score. Emitting three
// identical rows would be noise, so one match object per tie carries the rubber
// score, and the per-row detail (court, order) rides along in `raw`.
//
// Group tables come from the matchscorer groups widget instead — same host as
// the tour adapter — and are attached as `raw.standings` for context.
import { STATUS, gid } from "../schema.js";

// src/http.js is RankedIn-JSON only, and fip.js keeps its own headers for the
// same reason: these hosts serve HTML and want a browser UA + a padelfip Referer.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Referer: "https://www.padelfip.com/",
  Accept: "text/html,application/xhtml+xml",
};
const REQ_TIMEOUT_MS = 20_000;

async function getText(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

export const id = "puntuate";

const OOP = (tid) => `https://postafip.puntuate.com/ordenJuegoFip.aspx?idTorneo=${tid}&rf=0`;
const LIVE = (tid) => `${OOP(tid)}&enjuego=1`;

// Championships currently worth polling. Each needs its FIP event page (for the
// link) and, optionally, the matchscorer id that carries its group tables.
export const EVENTS = [
  {
    tid: "2309",
    msid: "FIP-2026-3918",
    name: "FIP World Cup Qualifiers – Europe",
    url: "https://www.padelfip.com/events/fip-world-cup-2026-qualifiers-europe-2026/",
    from: "2026-09-22",
    to: "2026-09-26",
  },
];

const TIE_RE =
  /^Match (\d+) (Male|Female) - Group Tie (\d+) - ([A-Z]_[A-Z]) - ([A-Z]{3})\s*(\d+)\s*-\s*(\d+)\s*([A-Z]{3})/;
const WHEN_RE = /^(\d{1,2}:\d{2}|Followed by|Not before)/i;

function textLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((l) => l.replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// -> { day, empty, ties: [{ gender, group, tieNo, a, b, a_score, b_score, court, when, rows }] }
export function parseSheet(html) {
  const lines = textLines(html);
  const day = lines.find((l) => /^[A-Z][a-z]+day, \d/.test(l)) || "";
  const empty = lines.some((l) => /No matches (scheduled|in play)/i.test(l));
  const ties = [];
  let court = "";
  lines.forEach((l, i) => {
    const c = /^COURT\s+(\S+)/i.exec(l);
    if (c) court = c[1];
    const m = TIE_RE.exec(l);
    if (!m) return;
    const [, no, gender, tieNo, group, a, sa, sb, b] = m;
    let when = "";
    for (let k = Math.max(0, i - 3); k < i; k++) if (WHEN_RE.test(lines[k])) when = lines[k];
    const key = `${gender}|${group}|${tieNo}|${a}|${b}`;
    let tie = ties.find((t) => t.key === key);
    if (!tie) {
      tie = {
        key, gender: gender === "Male" ? "Men" : "Women", group, tieNo: Number(tieNo),
        a, b, a_score: Number(sa), b_score: Number(sb), court, when, rows: [],
      };
      ties.push(tie);
    }
    // The tie score repeats on every row; the last one read is the freshest.
    tie.a_score = Number(sa);
    tie.b_score = Number(sb);
    tie.rows.push({ no: Number(no), court, when });
  });
  return { day, empty, ties };
}

// Group tables, best-effort: context only, never a reason to fail the adapter.
async function standings(msid, log) {
  try {
    const html = await getText(`https://widget.matchscorerlive.com/screen/groups/${msid}?t=tol`);
    const out = [];
    const draws = [...html.matchAll(/id="draw-(\d+)"/g)].map((m) => m.index);
    draws.forEach((start, di) => {
      const seg = html.slice(start, draws[di + 1] ?? html.length);
      const parts = seg.split(/<span[^>]*>\s*Group\s+([A-Z])\s*<\/span>/);
      for (let i = 1; i < parts.length - 1; i += 2) {
        const teams = [...parts[i + 1].matchAll(
          /group-index[^>]*>\s*(\d+)\.\s*<\/div>[\s\S]*?flags\/([A-Z]{3})\.jpg[\s\S]*?<span[^>]*>\s*([^<]+?)\s*<\/span>[\s\S]*?group-pts[^>]*>\s*([^<]*?)\s*<\/div>[\s\S]*?group-rubs[^>]*>\s*([^<]*?)\s*<\/div>/g,
        )].map((t) => ({ pos: Number(t[1]), code: t[2], name: t[3], pts: t[4], rubbers: t[5] }));
        if (teams.length) out.push({ draw: di === 0 ? "men" : "women", group: parts[i], teams });
      }
    });
    return out;
  } catch (err) {
    log(`puntuate: standings unavailable (${err.message})`);
    return [];
  }
}

const team = (code) => ({ name: code, players: [{ name: code, country: code }] });

export async function fetchMatches({ log = () => {}, now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const out = [];
  for (const ev of EVENTS) {
    if (ev.from && today < ev.from) continue;   // not started
    if (ev.to && today > ev.to) continue;       // over
    let sheet, live;
    try {
      sheet = parseSheet(await getText(OOP(ev.tid)));
      live = parseSheet(await getText(LIVE(ev.tid)));
    } catch (err) {
      log(`puntuate: ${ev.name} sheet unavailable (${err.message})`);
      continue;
    }
    const onCourt = new Set(live.empty ? [] : live.ties.map((t) => t.key));
    const table = await standings(ev.msid, log);

    for (const t of sheet.ties) {
      const decided = t.a_score + t.b_score >= 2;        // best of three rubbers
      const status = onCourt.has(t.key) ? STATUS.LIVE : decided ? STATUS.FINAL : STATUS.UPCOMING;
      const group = table.find(
        (g) => g.draw === (t.gender === "Men" ? "men" : "women") &&
               g.teams.some((x) => x.code === t.a) && g.teams.some((x) => x.code === t.b));
      out.push({
        id: gid(id, `${ev.tid}:${t.key}`),
        source: id,
        federation: "FIP",
        tournament: { id: ev.msid || ev.tid, name: ev.name, url: ev.url },
        className: t.gender,
        round: `Group ${t.group.replace("_", " ")} · Tie ${t.tieNo}`,
        court: t.court || null,
        status,
        startTime: null,
        schedule: t.when || null,
        teams: [team(t.a), team(t.b)],
        score: {
          sets: [[t.a_score, t.b_score]],
          winner: decided ? (t.a_score > t.b_score ? 0 : 1) : null,
        },
        raw: { day: sheet.day, rubbers: t.rows.length, rows: t.rows, standings: group || null },
      });
    }
    log(`puntuate: ${ev.name} — ${sheet.ties.length} tie(s), ${onCourt.size} on court (${sheet.day || "no day"})`);
  }
  return out;
}
