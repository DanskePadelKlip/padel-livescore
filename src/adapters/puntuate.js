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

// The group token (F_F / M_G) was on the 21 Sep preview sheet and GONE once play
// started on 22 Sep ("Group Tie 1 DNK 0 - 0 SRB"). Both shapes parse; the group
// is optional and only used for labelling.
// FIP's separators drift between sheets and between draws ON THE SAME DAY:
//   "Group Tie 1 DNK 0 - 0 SRB"          (men, 22 Sep)
//   "Group Tie 1 - DEU 2 - 0 HUN"        (women, 22 Sep - bare dash, no group)
//   "Group Tie 1 - F_F - BGR 0 - 0 GRC"  (21 Sep preview - group token)
// Both the dash and the group token are optional, independently.
const NATION_RE = /^\p{Lu}[\p{L} \-']{2,}$/u;       // "GREAT BRITAIN", "DENMARK", "Austria"
const ELAPSED_RE = /^\d+h \d+min$/;
// Player rows follow a tie row once the sheet goes live: NATION, two players, NATION, two.
const PLAYER_RE = /^\p{Lu}\.\s+\S/u;
const WHEN_RE = /^(\d{1,2}:\d{2}|Followed by|Not before)/i;
// All-caps used to be the whole nation test, and FIP typed "Austria" in title
// case on 22 Sep. It cost more than one label: both AUT v GBR rubbers hit the
// `sides.length < 2` guard and vanished, so that tie showed 0 of 3 while its tie
// row still read "AUT 0 - 3 GBR", and the unclaimed names bled UP into the match
// above - two Austrian men rendered inside a Norwegian women's pair on the live
// site. Title case is accepted now, which means the sheet's own vocabulary reads
// like a nation too, so it is excluded by name rather than by shape.
const SHEET_WORD_RE = /^(live|finished|in play|followed by|not before|walkover|retired|no matches.*)$/i;
const isNation = (x) => NATION_RE.test(x) && !SHEET_WORD_RE.test(x) && !WHEN_RE.test(x) && !/^\d/.test(x);

// The sheet serves every non-ASCII letter as a numeric entity ("M&#220;LLER"),
// and Node has no HTML parser to lean on. Named entities are the handful this
// page actually emits; the numeric forms cover the rest of Latin-1 and beyond.
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  bull: "\u2022", middot: "\u00b7", ndash: "\u2013", mdash: "\u2014",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  hellip: "\u2026", deg: "\u00b0", times: "\u00d7",
};
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] !== "#") {
      const hit = NAMED[body.toLowerCase()];
      return hit === undefined ? whole : hit;      // leave anything unknown as written
    }
    const code = body[1] === "x" || body[1] === "X"
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    // Lone surrogates and out-of-range values would throw; keep the source text.
    if (!Number.isFinite(code) || code < 32 || code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)) return whole;
    return String.fromCodePoint(code);
  });
}

function textLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((l) => decodeEntities(l).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Only the head of a tie row is stable. The tail - group token, nations, tie
// score - comes and goes between sheets, between draws on the same day, and
// again once a tie finishes.
// The head tolerates a tail printed in the WRONG PLACE, because FIP does that
// too: "Match 1 Male HUN 1 - 0 IRL - Group Tie 1 * 12:00". Anchoring straight
// after the gender dropped that row, and with it a whole rubber of that tie.
const TIE_HEAD_RE = /^Match (\d+) (Male|Female)(?:\s+[A-Z]{3}\s+\d+\s*-\s*\d+\s+[A-Z]{3})?\s*-\s*Group Tie (\d+)/;
const TIE_TAIL_ALT_RE =
  /^Match \d+ (?:Male|Female)\s+([A-Z]{3})\s+(\d+)\s*-\s*(\d+)\s+([A-Z]{3})\s*-\s*Group Tie/;
const TIE_TAIL_RE =
  /^Match \d+ (?:Male|Female) - Group Tie \d+(?:\s*-\s*([A-Z]_[A-Z]))?\s*-?\s*([A-Z]{3})\s+(\d+)\s*-\s*(\d+)\s+([A-Z]{3})/;

// A floor, not the source of truth: enough of the qualifier field that a sheet
// which has lost every code still parses. Anything else is learned below.
const STATIC_CODES = new Map(Object.entries({
  DENMARK: "DNK", SWEDEN: "SWE", NORWAY: "NOR", FINLAND: "FIN", ICELAND: "ISL",
  SERBIA: "SRB", CZECHIA: "CZE", GERMANY: "DEU", HUNGARY: "HUN", AUSTRIA: "AUT",
  "GREAT BRITAIN": "GBR", BELGIUM: "BEL", GREECE: "GRC", ROMANIA: "ROU",
  POLAND: "POL", SLOVENIA: "SVN", AZERBAIJAN: "AZE", NETHERLANDS: "NLD",
  CROATIA: "HRV", UKRAINE: "UKR", IRELAND: "IRL", LITHUANIA: "LTU",
  SWITZERLAND: "CHE", GEORGIA: "GEO", BULGARIA: "BGR", CYPRUS: "CYP",
}));

// The nation lines of the block under a row: NATION, its two players, NATION,
// its two. Stops at the next row or court header so it cannot read the block
// after this one.
function blockNations(lines, i) {
  const out = [];
  for (const x of lines.slice(i + 1, i + 20)) {
    if (TIE_HEAD_RE.test(x) || /^COURT\s/i.test(x)) break;
    if (PLAYER_RE.test(x)) continue;
    if (isNation(x)) out.push(x);
  }
  return out;
}

// Every row that still carries its codes teaches the mapping for the nations
// named in its own block, so a sheet translates itself and no hand-kept table
// has to keep up with FIP's field.
function learnCodes(lines) {
  const map = new Map(STATIC_CODES);
  lines.forEach((l, i) => {
    const t = TIE_TAIL_RE.exec(l);
    if (!t) return;
    const names = blockNations(lines, i);
    if (names.length >= 2) { map.set(names[0], t[2]); map.set(names[1], t[5]); }
  });
  return map;
}

// The row's own nations and tie score when it still has them, else the block's
// nation names translated. `scored` says which: a row without a tail states no
// tie score, and guessing one would overwrite a real one with zeroes.
function rowTeams(lines, i, codes) {
  const t = TIE_TAIL_RE.exec(lines[i]);
  if (t) {
    return { group: t[1] || "", a: t[2], b: t[5], sa: Number(t[3]), sb: Number(t[4]), scored: true };
  }
  const alt = TIE_TAIL_ALT_RE.exec(lines[i]);
  if (alt) {
    return { group: "", a: alt[1], b: alt[4], sa: Number(alt[2]), sb: Number(alt[3]), scored: true };
  }
  const names = blockNations(lines, i);
  const a = codes.get(names[0]), b = codes.get(names[1]);
  if (!a || !b) return null;      // an unknown nation is skipped, never invented
  return { group: "", a, b, sa: null, sb: null, scored: false };
}

// -> { day, empty, ties: [{ gender, group, tieNo, a, b, a_score, b_score, court, when, rows }] }
export function parseSheet(html) {
  const lines = textLines(html);
  const day = lines.find((l) => /^[A-Z][a-z]+day, \d/.test(l)) || "";
  const empty = lines.some((l) => /No matches (scheduled|in play)/i.test(l));
  const codes = learnCodes(lines);
  const ties = [];
  let court = "";
  lines.forEach((l, i) => {
    const c = /^COURT\s+(\S+)/i.exec(l);
    if (c) court = c[1];
    const head = TIE_HEAD_RE.exec(l);
    if (!head) return;
    const [, no, gender, tieNo] = head;
    const t = rowTeams(lines, i, codes);
    if (!t) return;
    const { group, a, b, sa, sb } = t;
    const players = lines.slice(i + 1, i + 7).filter((x) => PLAYER_RE.test(x)).slice(0, 4);
    let when = "";
    for (let k = Math.max(0, i - 3); k < i; k++) if (WHEN_RE.test(lines[k])) when = lines[k];
    const key = `${gender}|${group}|${tieNo}|${a}|${b}`;
    let tie = ties.find((t) => t.key === key);
    if (!tie) {
      tie = {
        key, gender: gender === "Male" ? "Men" : "Women", group, tieNo: Number(tieNo),
        a, b, a_score: sa || 0, b_score: sb || 0, court, when, rows: [],
      };
      ties.push(tie);
    }
    // The tie score repeats on every row; the last one read is the freshest.
    // A row that has lost its tail states no score, so it must not zero one.
    if (t.scored) { tie.a_score = sa; tie.b_score = sb; }
    tie.rows.push({ no: Number(no), court, when, players });
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

// The LIVE view (enjuego=1) is a different shape to the order of play: under each
// tie row it prints elapsed time, then each nation with its two players and one
// number PER SET. That is the only place FIP publishes a per-match score for a
// championship, so it is what a scoreboard can follow.
//   BULGARIA  Z. KISELKOVA  A. KARAMANOLEVA  3 0 0
//   GREECE    A. MELIGALIOTI  A. PALASKA      6 1 0
export function parseLive(html, fallback = "live") {
  const lines = textLines(html);
  const codes = learnCodes(lines);
  const out = [];
  let court = "";
  lines.forEach((l, i) => {
    const c = /^COURT\s+(\S+)/i.exec(l);
    if (c) court = c[1];
    const head = TIE_HEAD_RE.exec(l);
    if (!head) return;
    const [, no, gender, tieNo] = head;
    const t = rowTeams(lines, i, codes);
    if (!t) return;
    const { group: groupRaw, a, b, sa, sb } = t;
    const elapsed = ELAPSED_RE.test(lines[i + 1] || "") ? lines[i + 1] : "";
    // The sheet labels each entry Live or Finished on the line above it. That
    // label - not the numbers - is what says whether the last column is the
    // CURRENT POINT: a live match always carries one (even at 0), a finished
    // one never does.
    const label = (lines[i - 1] || "").toLowerCase();
    const finished = label.indexOf("finished") >= 0;
    // No label means different things in the two views: in the live view the
    // match is on court by definition, in the order-of-play sheet it is simply
    // not played yet. The caller knows which sheet it handed us.
    const state = finished ? "final"
      : label.indexOf("live") >= 0 ? "live"
      : fallback;
    const sides = [];
    let cur = null;
    for (const x of lines.slice(i + 1, i + 20)) {
      if (TIE_HEAD_RE.test(x) || /^COURT\s/i.test(x)) break;   // next match starts
      if (isNation(x)) { cur = { nation: x, players: [], cols: [] }; sides.push(cur); continue; }
      if (!cur) continue;
      if (PLAYER_RE.test(x)) cur.players.push(x);
      else if (/^\d+$/.test(x)) cur.cols.push(Number(x));
    }
    if (sides.length < 2) return;
    const [A, B] = sides;
    // Columns are completed sets, then the current games, then the CURRENT POINT
    // (0/15/30/40). Folding the point into `sets` produced "0-15" as if it were a
    // set score, so the last column is split off when it looks like a point.
    const n = Math.max(A.cols.length, B.cols.length);
    const cols = [];
    for (let k = 0; k < n; k++) cols.push([A.cols[k] ?? 0, B.cols[k] ?? 0]);
    let points = null;
    // Live -> the last column is the point (0/15/30/40), so it must come OUT of
    // the set list. Leaving a 0-0 point in there cost us on air: the board read
    // the real current games as a completed set and gave Denmark a second one.
    if (state === "live" && cols.length > 1) points = cols.pop().map(String);
    const sets = cols;
    out.push({
      key: `${gender}|${groupRaw || ""}|${tieNo}|${a}|${b}`,
      matchNo: Number(no), gender: gender === "Male" ? "Men" : "Women",
      group: groupRaw || "", tieNo: Number(tieNo), a, b,
      tieScore: t.scored ? [sa, sb] : null, court, elapsed, finished, state,
      sides: [A, B], sets, points,
    });
  });
  return out;
}

// Everything one event contributes, from one read of its two views. Split out of
// fetchMatches so the live relay can build the same rows per request, with no
// deploy between FIP and the board. `withStandings` is off there: the group
// table comes from a second host and a scoreboard does not use it.
// The sheet states its own date ("Tuesday, 22 September 2026") and no row carries
// one. Without a `day` the UI's matchDate() returns null, and the live feed's day
// strip - which defaults to today - filters every national-team match out of the
// page while it sits in matches.json, scores and all. This is the THIRD time the
// stamp has had to be restored (73852da, 9b6f491), so if you rewrite eventRows,
// keep it: public/app.js also fails open on undated rows, but that is the net,
// not the fix.
//
// It belongs here and not in fetchMatches because functions/api/live-rows.js
// calls eventRows() directly - a stamp added there reaches matches.json only.
// Derived from the sheet text rather than the clock: this runs in the laptop
// daemon (local time) and on Cloudflare (UTC), and a machine clock would label
// the two differently either side of midnight CEST.
// Label grammar is the one public/app.js matchDate() parses: "SEP 22 TUE".
const MON_FULL = "january february march april may june july august september october november december".split(" ");
const MON_ABBR = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split(" ");
const WD_ABBR = "SUN MON TUE WED THU FRI SAT".split(" ");
function sheetDay(text, from) {
  const m = /([A-Za-z]+),?\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(text || "");
  if (!m) return null;                       // no day line on the sheet - stay undated
  const mo = MON_FULL.indexOf(m[3].toLowerCase());
  if (mo < 0) return null;
  const dom = Number(m[2]);
  const ms = Date.UTC(Number(m[4]), mo, dom);
  const label = `${MON_ABBR[mo]} ${dom} ${WD_ABBR[new Date(ms).getUTCDay()]}`;
  if (!from) return { n: null, label };
  const [fy, fm, fd] = from.split("-").map(Number);
  const n = Math.round((ms - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1;
  return { n: n >= 1 ? n : null, label };
}

export async function eventRows(ev, { log = () => {}, withStandings = true } = {}) {
  const out = [];
  {
    let sheet, live;
    let liveHtml = "";
    let sheetMatches = [];
    try {
      const oopHtml = await getText(OOP(ev.tid));
      sheet = parseSheet(oopHtml);
      sheetMatches = parseLive(oopHtml, "upcoming");
      liveHtml = await getText(LIVE(ev.tid));
      live = parseSheet(liveHtml);
    } catch (err) {
      log(`puntuate: ${ev.name} sheet unavailable (${err.message})`);
      return out;
    }
    const onCourt = new Set(live.empty ? [] : live.ties.map((t) => t.key));
    const day = sheetDay(sheet.day || live.day, ev.from);
    const liveMatches = live.empty ? [] : parseLive(liveHtml);
    // Every match of the day, with the live view overriding the sheet for the
    // ones on court. Keyed the same way the rows are, so the override is exact.
    const byKey = new Map();
    for (const sm of sheetMatches) byKey.set(`${sm.key}:m${sm.matchNo}`, sm);
    for (const lm of liveMatches) byKey.set(`${lm.key}:m${lm.matchNo}`, lm);
    const matches = [...byKey.values()];
    const table = withStandings ? await standings(ev.msid, log) : [];

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
        round: t.group ? `Group ${t.group.replace("_", " ")} · Tie ${t.tieNo}` : `Tie ${t.tieNo}`,
        court: t.court || null,
        status,
        startTime: null,
        schedule: t.when || null,
        day,
        teams: [team(t.a), team(t.b)],
        score: {
          sets: [[t.a_score, t.b_score]],
          winner: decided ? (t.a_score > t.b_score ? 0 : 1) : null,
        },
        raw: { day: sheet.day, rubbers: t.rows.length, rows: t.rows, standings: group || null },
      });
    }
    // One row per match actually on court, carrying the real set scores and the
    // player names - this is what the scoreboard follows.
    for (const lm of matches) {
      const side = (s2) => ({
        name: s2.players.map((p) => p.replace(/^[A-Z]\.\s*/, "")).join(" / ") || s2.nation,
        players: s2.players.map((p) => ({ name: p, country: null })),
      });
      out.push({
        id: gid(id, `${ev.tid}:${lm.key}:m${lm.matchNo}`),
        source: id,
        federation: "FIP",
        tournament: { id: ev.msid || ev.tid, name: ev.name, url: ev.url },
        className: `${lm.gender} · ${lm.a} v ${lm.b}`,
        day,
        round: lm.group ? `Group ${lm.group.replace("_", " ")} · Match ${lm.matchNo}`
                        : `Tie ${lm.tieNo} · Match ${lm.matchNo}`,
        court: lm.court || null,
        status: lm.state === "final" ? STATUS.FINAL
              : lm.state === "live" ? STATUS.LIVE : STATUS.UPCOMING,
        startTime: null,
        schedule: null,
        teams: [side(lm.sides[0]), side(lm.sides[1])],
        score: {
          sets: lm.sets,
          // Only a finished rubber has a winner, and the sheet never states it:
          // count the sets. A retirement leaves an odd-looking set list, so this
          // stays a simple majority rather than pretending to know more.
          winner: lm.state === "final" && lm.sets.length
            ? (lm.sets.filter((s) => s[0] > s[1]).length >
               lm.sets.filter((s) => s[1] > s[0]).length ? 0 : 1)
            : null,
          ...(lm.points ? { points: lm.points } : {}),
        },
        raw: { elapsed: lm.elapsed, tieScore: lm.tieScore, nations: [lm.a, lm.b] },
      });
    }
    log(`puntuate: ${ev.name} — ${sheet.ties.length} tie(s), ${matches.length} match(es), ${liveMatches.length} on court (${sheet.day || "no day"})`);
  }
  return out;
}

// The daemon's entry point: every event inside its dates, in one array.
export async function fetchMatches({ log = () => {}, now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const out = [];
  for (const ev of EVENTS) {
    if (ev.from && today < ev.from) continue;   // not started
    if (ev.to && today > ev.to) continue;       // over
    out.push(...(await eventRows(ev, { log })));
  }
  return out;
}
