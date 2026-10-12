// Premier Padel match stats -> static files the match page reads.
//
//   node scripts/build-ppstats.mjs            # reads PP_CAPTURE_DIR or ~/premierpadel-capture
//   node scripts/build-ppstats.mjs --check    # also print how many FIP matches in
//                                             # public/data/matches.json found their stats
//
// Input is the raw capture written by scripts/capture-premierpadel.mjs (outside the
// repo). Output, tracked in git so GitHub Actions deploys carry it too:
//   public/data/ppstats/index.json    [{ s: slug, a: firstDay, b: lastDay }]
//   public/data/ppstats/<slug>.json   { s, m: [match, ...] }
//
// The match page knows a FIP tournament by FIP's id and name, which share nothing
// with Premier Padel's slug (FIP prints "CUPRA GERMANY PREMIER PADEL P2", PP says
// "GERMANY P2"; the ids are unrelated). So nothing here tries to map one event to the
// other. The client takes every PP event whose dates cover the match, opens those
// files (one, at most two on an overlap week) and looks for the PAIR: both teams'
// surnames must match. That is the proof, not the name.
//
// One match:
//   { r: "R64", d: "2026-10-12", u: "02:17", t: [["ortega","axelsson"], ["cepero","fernandezlancha"]],
//     w: 2, x: { M: [...], 1: [...], 2: [...], 3: [...] } }
// t = surname keys per team, PP's team order (team_no 1, 2); w = PP's winner_id.
// x = stat blocks ("M" whole match, "1".."5" per set), each a flat array of
//   [won1, played1, won2, played2] for total points, serve points, 1st serve points,
//   2nd serve points, return points, 1st return points, 2nd return points,
//   then [streak1, streak2] - 30 numbers. Aces and double faults are left out on
//   purpose: Premier Padel records 0-0 for every match, so they would only mislead.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAP = process.env.PP_CAPTURE_DIR || join(homedir(), "premierpadel-capture");
// PPSTATS_OUT lets a dry run write somewhere the refresh daemon does not deploy.
const OUT = process.env.PPSTATS_OUT || join(ROOT, "public", "data", "ppstats");
const CHECK = process.argv.includes("--check");

// Must match surnameKey/normName in public/app.js and functions/_matchkey.js.
const normName = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

const ROWS = [
  ["total_points", "Total Points Won"],
  ["total_points", "Total Serve Points Won"],
  ["service", "First Serve Points Won"],
  ["service", "Second Serve Points Won"],
  ["total_points", "Total Return Points Won"],
  ["return", "First Return Points Won"],
  ["return", "Second Return Points Won"],
];
const num = (v) => (v === "" || v == null || isNaN(+v) ? null : +v);

function block(b) {
  const out = [];
  for (const [grp, title] of ROWS) {
    const r = (b[grp] || []).find((x) => x.title === title);
    if (!r) return null;
    out.push(num(r.team_1.won), num(r.team_1.played), num(r.team_2.won), num(r.team_2.played));
  }
  const s = (b.total_points || []).find((x) => x.title === "Longest Points Won Streak");
  out.push(s ? num(s.team_1.title) : null, s ? num(s.team_2.title) : null);
  // a block with nothing played is a set that was never reached
  return out[1] ? out : null;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

const index = [];
let nMatches = 0, nStats = 0;
mkdirSync(OUT, { recursive: true });

const years = readdirSync(CAP).filter((f) => /^tournaments-\d{4}\.json$/.test(f)).sort();
const tours = new Map();
for (const f of years) for (const t of readJson(join(CAP, f))?.data || []) if (t.slug) tours.set(t.slug, t);

for (const [slug, t] of tours) {
  const dir = join(CAP, slug);
  if (!existsSync(dir)) continue;
  const byId = new Map();
  for (const f of readdirSync(dir).filter((f) => /^day-.*\.json$/.test(f)).sort()) {
    for (const c of readJson(join(dir, f))?.data?.courts || []) for (const m of c.matches || []) byId.set(m.match_id, m);
  }
  const ms = [];
  let first = null, last = null;
  for (const [id, m] of byId) {
    if (m.date) { if (!first || m.date < first) first = m.date; if (!last || m.date > last) last = m.date; }
    if (m.status !== "F") continue;
    nMatches++;
    const st = readJson(join(dir, "stats", `${id}.json`));
    const blocks = st?.data?.match_state;
    if (!Array.isArray(blocks)) continue;
    const x = {};
    for (const b of blocks) {
      const k = b.title === "Match" ? "M" : (/^Set (\d)$/.exec(b.title) || [])[1];
      const v = k && block(b);
      if (v) x[k] = v;
    }
    if (!x.M) continue;
    const teams = [...(m.teams || [])].sort((a, b) => a.team_no - b.team_no);
    if (teams.length !== 2) continue;
    const t2 = teams.map((tm) => (tm.players || []).map((p) => normName(p.last_name)).filter(Boolean));
    if (t2.some((x) => !x.length)) continue;
    nStats++;
    ms.push({ r: m.round_name || "", d: m.date || "", u: (m.duration || "").slice(0, 5), t: t2, w: +m.winner_id || 0, x });
  }
  if (!ms.length) continue;
  ms.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const a = first || (t.start_date_utc || "").slice(0, 10), b = last || (t.end_date_utc || "").slice(0, 10);
  index.push({ s: slug, a, b });
  writeIfChanged(join(OUT, `${slug}.json`), JSON.stringify({ s: slug, m: ms }));
}
index.sort((p, q) => (p.a < q.a ? -1 : 1));
writeIfChanged(join(OUT, "index.json"), JSON.stringify(index));
console.log(`ppstats: ${index.length} events, ${nStats} of ${nMatches} finished matches with stats`);

function writeIfChanged(p, s) {
  if (existsSync(p) && readFileSync(p, "utf8") === s) return;
  writeFileSync(p, s);
}

// --check: the client's own matching rule, run over today's FIP rows.
if (CHECK) {
  const live = readJson(join(ROOT, "public", "data", "matches.json"));
  const DRAW_MARKER = /\s*(\((?:\d+|WC|Q|LL|SE|A)(?:\s*-\s*\w+)?\))\s*$/i;
  const surnameKey = (name) => {
    const n = String(name || "").replace(DRAW_MARKER, "").trim();
    const i = /^\S\.\s+(.+)$/.exec(n);
    if (i) return normName(i[1]);
    const toks = n.split(/\s+/);
    return normName(toks.length > 1 ? toks.slice(1).join(" ") : n);
  };
  const files = new Map(index.map((e) => [e.s, readJson(join(OUT, `${e.s}.json`))]));
  let tried = 0, found = 0;
  const per = {};
  const miss = [];
  for (const m of live?.matches || []) {
    if (m.source !== "fip" || m.status !== "final") continue;
    const day = (m.startTime || "").slice(0, 10) || null;
    const evs = index.filter((e) => dayIn(day || (live.date || ""), e));
    if (!evs.length) continue;
    tried++;
    const pt = (per[m.tournament.name] ||= [0, 0]); pt[1]++;
    const fipTeams = m.teams.map((t) => (t.players || []).map((p) => surnameKey(p.name)));
    const hit = evs.some((e) => (files.get(e.s)?.m || []).some((x) => sameMatch(x.t, fipTeams)));
    if (hit) { found++; pt[0]++; } else miss.push(`${m.tournament.name} ${m.round}: ${m.teams.map((t) => t.name).join(" vs ")}`);
  }
  console.log(`check: ${found} of ${tried} final FIP matches in PP weeks found their stats`);
  for (const [k, [f, n]] of Object.entries(per)) console.log(`  ${k}: ${f}/${n}`);
  for (const s of miss.filter((s) => !/^FIP /.test(s)).slice(0, 40)) console.log("  miss " + s);
}

function dayIn(day, e) {
  if (!day) return false;
  const d = Date.parse(day), a = Date.parse(e.a) - 2 * 864e5, b = Date.parse(e.b) + 864e5;
  return d >= a && d <= b;
}
// Same rule as ppSameTeam in public/app.js.
function sameName(a, b) { return a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))); }
// Every FIP player must be in the PP team; PP lists four when a lucky loser replaced a pair.
function sameTeam(p, f) { return f.length > 0 && p.length >= f.length && f.every((y) => p.some((x) => sameName(x, y))); }
function sameMatch(pp, fip) {
  return (sameTeam(pp[0], fip[0]) && sameTeam(pp[1], fip[1])) || (sameTeam(pp[0], fip[1]) && sameTeam(pp[1], fip[0]));
}
