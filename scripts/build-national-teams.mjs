#!/usr/bin/env node
// Build public/data/national-teams.json — every nation's placing in international
// national-TEAM championships — from the archived draws this repo already ships
// (public/data/archive/t/<key>.json). Run: `node scripts/build-national-teams.mjs`.
//
// WHY A SCRIPT AND NOT A HAND-TYPED TABLE. The old Denmark-only file (removed in
// 8f774e2) was 22 hand-entered rows. An international table is ~60 nations per
// edition, which nobody can hand-check. Deriving it from the draw that is already
// in the repo makes every placing re-checkable: rerun this and diff.
//
// WHAT COUNTS AS SOURCED. Only a placing the draw *states* is emitted:
//
//   * FIP team championships are played as a FULL PLACEMENT BRACKET. After the
//     groups, every nation keeps playing until it has an exact place: the round
//     labelled "Final" is eight ties, one per position pair (1/2, 3/4, … 15/16),
//     not one gold-medal match. So the bracket assigns each nation one position,
//     and reading it is reading the draw, not guessing.
//   * The only thing the bracket does NOT state is which half of the post-group
//     split is the championship half. That comes from the group table — and only
//     when the group is decided on ties won with a STRICT gap at the split line,
//     so no federation tie-break rule is ever needed or invented.
//
// Every assertion below is a refusal, not a warning: if a draw does not satisfy
// them the event emits NO rows and is listed as a gap, because a wrong placing is
// worse than a missing one. `--check` additionally re-derives Denmark's placings
// and compares them to the 22 independently sourced rows of the removed file.
//
// NOT DERIVABLE, and why (these stay gaps until a final classification is in hand):
//   * fip-137970 (European 2024) — the archived draw carries NO round labels and
//     no dates, so the ties cannot be ordered into a bracket at all.
//   * rin-42477 / rin-47618 / rin-63840 — RankedIn team ties come through with
//     `score.winner === 0` on every single match and a nonsense set score, so the
//     file does not say who won anything.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARCH = path.join(ROOT, "public", "data", "archive", "t");
const OUT = path.join(ROOT, "public", "data", "national-teams.json");

// ---------------------------------------------------------------- the events
// `classes` maps the draw's className to our gender key. FIP's world-championship
// export leaves the women's className EMPTY (the men's says "Men"), so it is
// spelled out per event rather than guessed.
const EVENTS = [
  {
    key: "fip-135412",
    comp: "World Championship",
    body: "FIP",
    cat: "Senior",
    year: 2024,
    classes: { "": "women", Men: "men" },
    knockout: ["Quarterfinals", "SemiFinals", "Final"],
  },
  {
    key: "fip-296741",
    comp: "Junior Euro Padel Cup",
    body: "FIP",
    cat: "Junior",
    year: 2026,
    classes: { Men: "men", Women: "women" },
    knockout: ["SemiFinals", "Final"],
  },
  {
    key: "fip-296740",
    comp: "Junior Africa Padel Cup",
    body: "FIP",
    cat: "Junior",
    year: 2026,
    classes: { Men: "men", Women: "women" },
    knockout: ["Final"],
  },
];

// Events we deliberately do NOT derive. Carried into the JSON so the page can say
// what is missing instead of silently ending at the events that happen to work.
const GAPS = [
  {
    key: "fip-137970",
    comp: "European Championship",
    body: "FIP",
    cat: "Senior",
    year: 2024,
    where: "Italy",
    why: "The archived draw has no round labels and no dates, so its 287 ties cannot be ordered into a bracket. FIP published a final classification; it is not in any file on this branch.",
  },
  {
    key: "rin-42477",
    comp: "Junior European Championship (by teams)",
    body: "FIP",
    cat: "Junior",
    year: 2024,
    where: "Budapest, Hungary",
    why: "RankedIn team ties export with score.winner = 0 on all 76 matches and a set score that is not a result, so the file does not say who won. The position rounds (1-8, 9-12, 9-16) are labelled but empty of outcomes.",
  },
  {
    key: "rin-47618",
    comp: "Nordic Team Championships",
    body: "Nordic",
    cat: "Senior / Veteran / Junior",
    year: 2025,
    where: "Drammen, Norway",
    why: "Same RankedIn export problem: winner = 0 on all 36 ties.",
  },
  {
    key: "rin-63840",
    comp: "Nordic Team Championships",
    body: "Nordic",
    cat: "Senior / Veteran / Junior",
    year: 2026,
    where: "Denmark",
    why: "Same RankedIn export problem: winner = 0 on all 48 ties.",
  },
];

// IOC/FIP 3-letter → ISO alpha-2 + English name. Only codes that actually occur in
// the events above; an unknown code is a hard error rather than a blank row.
const COUNTRY = {
  ARG: ["AR", "Argentina"], AUT: ["AT", "Austria"], BEL: ["BE", "Belgium"],
  BRA: ["BR", "Brazil"], CHI: ["CL", "Chile"], CYP: ["CY", "Cyprus"],
  CZE: ["CZ", "Czechia"], DEN: ["DK", "Denmark"], EGY: ["EG", "Egypt"],
  ESP: ["ES", "Spain"], EST: ["EE", "Estonia"], FIN: ["FI", "Finland"],
  FRA: ["FR", "France"], GBR: ["GB", "Great Britain"], GER: ["DE", "Germany"],
  HUN: ["HU", "Hungary"], ITA: ["IT", "Italy"], JPN: ["JP", "Japan"],
  LTU: ["LT", "Lithuania"], MDA: ["MD", "Moldova"], MEX: ["MX", "Mexico"],
  NED: ["NL", "Netherlands"], NOR: ["NO", "Norway"], PAR: ["PY", "Paraguay"],
  POL: ["PL", "Poland"], POR: ["PT", "Portugal"], QAT: ["QA", "Qatar"],
  SEN: ["SN", "Senegal"], SUI: ["CH", "Switzerland"], SWE: ["SE", "Sweden"],
  TUN: ["TN", "Tunisia"], UAE: ["AE", "United Arab Emirates"],
  UKR: ["UA", "Ukraine"], URU: ["UY", "Uruguay"], USA: ["US", "United States"],
};

const GROUP_ROUND = "Group stage";

// ------------------------------------------------------------------- helpers
class Refuse extends Error {}
const refuse = (msg) => { throw new Refuse(msg); };

/** A rubber's side is a nation only when every player on it carries the same country. */
function sideNation(team) {
  const cs = [...new Set((team.players || []).map((p) => p.country).filter(Boolean))];
  return cs.length === 1 ? cs[0] : null;
}

/**
 * Collapse rubbers into national ties: {round, a, b, winner, wa, wb, rubbers}.
 * A tie with more rubbers than `maxRubbers` means two separate meetings were
 * merged under one round label — that is ambiguous, so it is dropped and counted.
 */
function buildTies(draw, gender, classes, maxRubbers = 5) {
  const ties = new Map();
  let skipped = 0;
  for (const m of draw.matches) {
    if (classes[m.className ?? ""] !== gender) continue;
    const a = sideNation(m.teams?.[0]);
    const b = sideNation(m.teams?.[1]);
    if (!a || !b || a === b) { skipped++; continue; }
    const [x, y] = [a, b].sort();
    const k = `${m.round}::${x}|${y}`;
    if (!ties.has(k)) ties.set(k, { round: m.round, a: x, b: y, wa: 0, wb: 0, rubbers: 0 });
    const t = ties.get(k);
    t.rubbers++;
    const w = m.score?.winner;
    const won = w === 0 ? a : w === 1 ? b : null;
    if (won === x) t.wa++; else if (won === y) t.wb++;
  }
  const out = [];
  let ambiguous = 0;
  for (const t of ties.values()) {
    if (t.rubbers > maxRubbers) { ambiguous++; continue; }
    if (t.wa === t.wb) { ambiguous++; continue; } // undecided or unplayed — never guess
    t.winner = t.wa > t.wb ? t.a : t.b;
    t.loser = t.wa > t.wb ? t.b : t.a;
    out.push(t);
  }
  return { ties: out, skipped, ambiguous };
}

/** Connected components of the group-tie graph restricted to `teams`. */
function groupsOf(groupTies, teams) {
  const adj = new Map([...teams].map((t) => [t, new Set()]));
  for (const t of groupTies) {
    if (!adj.has(t.a) || !adj.has(t.b)) continue;
    adj.get(t.a).add(t.b);
    adj.get(t.b).add(t.a);
  }
  const seen = new Set(), out = [];
  for (const t of teams) {
    if (seen.has(t)) continue;
    const comp = [], stack = [t];
    seen.add(t);
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      for (const n of adj.get(c)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    out.push(comp);
  }
  return out;
}

/**
 * Rank a group strictly by ties won. Returns the ordered codes, or refuses when
 * two teams are level — a level group needs the federation's tie-break rules,
 * which are not in any file here, and inventing one would invent a placing.
 */
function rankGroup(groupTies, members, splitAt) {
  const wins = new Map(members.map((m) => [m, 0]));
  let played = 0;
  for (const t of groupTies) {
    if (!wins.has(t.a) || !wins.has(t.b)) continue;
    played++;
    wins.set(t.winner, wins.get(t.winner) + 1);
  }
  const expect = (members.length * (members.length - 1)) / 2;
  if (played !== expect) refuse(`group ${members.join("/")} played ${played} ties, a full round robin is ${expect}`);
  const order = [...members].sort((x, y) => wins.get(y) - wins.get(x));
  // Only the gap AT THE SPLIT LINE has to be strict — positions inside a half are
  // decided by the bracket that follows, not by the group table.
  if (splitAt != null && wins.get(order[splitAt - 1]) === wins.get(order[splitAt])) {
    refuse(`group ${members.join("/")} is level on ties won across the ${splitAt}/${splitAt + 1} split line`);
  }
  return { order, wins };
}

const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");

/**
 * Name the deciding tie. FIP labels every placement decider "Final", so 15/16 would
 * read "the final" — say which place was at stake instead, from the block it settled.
 */
function decider(round, from) {
  if (round !== "Final") return round.toLowerCase().replace("semifinals", "semi-finals").replace("quarterfinals", "quarter-finals");
  if (from === 1) return "the final";
  if (from === 3) return "the third-place match";
  return `the ${ord(from)}-place match`;
}

/** Human note for the tie that settled a nation's place. */
const viaText = (t, code, from) =>
  t.winner === code
    ? `beat ${t.loser} ${Math.max(t.wa, t.wb)}-${Math.min(t.wa, t.wb)} in ${decider(t.round, from)}`
    : `lost ${Math.min(t.wa, t.wb)}-${Math.max(t.wa, t.wb)} to ${t.winner} in ${decider(t.round, from)}`;

/**
 * Walk the placement bracket. Blocks start as one range of positions and halve on
 * every knockout round: winners take the top half, losers the bottom half. When the
 * field is twice as large as the knockout rounds can resolve, the group table
 * supplies exactly one extra split first (championship half vs classification half).
 */
function derive(ev, draw, gender) {
  const { ties, ambiguous } = buildTies(draw, gender, ev.classes);
  const byRound = (r) => ties.filter((t) => t.round === r);
  const rounds = ev.knockout.filter((r) => byRound(r).length);
  if (!rounds.length) refuse("no knockout rounds in the draw");

  const first = byRound(rounds[0]);
  const field = new Set(first.flatMap((t) => [t.a, t.b]));
  if (field.size !== first.length * 2) refuse(`round ${rounds[0]} does not pair every nation exactly once`);

  const groupTies = byRound(GROUP_ROUND);
  const resolvable = 2 ** rounds.length;
  let blocks = [{ teams: new Set(field), from: 1 }];

  if (field.size === resolvable * 2) {
    // one group-table split
    const groups = groupsOf(groupTies, field);
    const size = groups[0].length;
    if (groups.some((g) => g.length !== size)) refuse("the post-group field is not split into equal groups");
    if (size % 2) refuse(`groups of ${size} cannot split in half`);
    const upper = new Set();
    for (const g of groups) {
      const { order } = rankGroup(groupTies, g, size / 2);
      order.slice(0, size / 2).forEach((c) => upper.add(c));
    }
    if (upper.size !== field.size / 2) refuse("the championship half is not half the field");
    blocks = [
      { teams: upper, from: 1 },
      { teams: new Set([...field].filter((c) => !upper.has(c))), from: field.size / 2 + 1 },
    ];
  } else if (field.size !== resolvable) {
    refuse(`a field of ${field.size} cannot be resolved by ${rounds.length} knockout round(s)`);
  }

  const via = new Map();
  for (const r of rounds) {
    const rt = byRound(r);
    const next = [];
    for (const b of blocks) {
      const mine = rt.filter((t) => b.teams.has(t.a) && b.teams.has(t.b));
      if (mine.length * 2 !== b.teams.size) refuse(`round ${r} does not pair the block at position ${b.from} within itself`);
      const half = b.teams.size / 2;
      const w = new Set(), l = new Set();
      for (const t of mine) { w.add(t.winner); l.add(t.loser); via.set(t.winner, { t, from: b.from }); via.set(t.loser, { t, from: b.from }); }
      if (w.size !== half || l.size !== half) refuse(`round ${r} block at position ${b.from} did not halve cleanly`);
      next.push({ teams: w, from: b.from }, { teams: l, from: b.from + half });
    }
    blocks = next;
  }
  if (blocks.some((b) => b.teams.size !== 1)) refuse("the bracket did not resolve every nation to one position");

  const rows = [];
  for (const b of blocks) {
    const code = [...b.teams][0];
    const v = via.get(code);
    rows.push({ c: code, pos: b.from, via: viaText(v.t, code, v.from) });
  }

  // Nations that played the final group phase but never entered the bracket. Only
  // ordered when ONE group is involved and the tail is strictly separated — with
  // several groups there is nothing that ranks a 3rd of group A against a 3rd of B.
  const groups = groupsOf(groupTies, new Set(groupTies.flatMap((t) => [t.a, t.b])));
  const home = groups.filter((g) => g.some((c) => field.has(c)));
  const tail = [];
  if (home.length === 1) {
    const g = home[0];
    const outside = g.filter((c) => !field.has(c));
    if (outside.length) {
      const { order, wins } = rankGroup(groupTies, g, null);
      const cut = order.findIndex((c) => !field.has(c));
      if (order.slice(0, cut).some((c) => !field.has(c)) || order.slice(cut).some((c) => field.has(c))) {
        refuse("group table and bracket field disagree about who went through");
      }
      for (let i = cut; i < order.length; i++) {
        if (i + 1 < order.length && wins.get(order[i]) === wins.get(order[i + 1])) {
          refuse("nations outside the bracket are level on ties won");
        }
        tail.push({ c: order[i], pos: i + 1, via: `${wins.get(order[i])} of ${g.length - 1} group ties won; no placement match` });
      }
    }
  }
  rows.push(...tail);

  // Nations that took part but have no placing the draw states.
  const placed = new Set(rows.map((r) => r.c));
  const entered = new Set(ties.flatMap((t) => [t.a, t.b]));
  const unplaced = [...entered].filter((c) => !placed.has(c)).sort();

  rows.sort((a, b) => a.pos - b.pos);
  return { rows, unplaced, ambiguous };
}

// ---------------------------------------------------------------------- main
const events = [], rows = [], problems = [];

for (const ev of EVENTS) {
  const file = path.join(ARCH, `${ev.key}.json`);
  if (!fs.existsSync(file)) { problems.push(`${ev.key}: archive file missing`); continue; }
  const draw = JSON.parse(fs.readFileSync(file, "utf8"));
  const genders = [...new Set(Object.values(ev.classes))];
  const meta = {
    id: ev.key,
    comp: ev.comp,
    body: ev.body,
    cat: ev.cat,
    year: ev.year,
    name: draw.name,
    start: draw.start,
    end: draw.end,
    where: draw.address || draw.venue || "",
    tkey: ev.key,
    genders: [],
    unplaced: {},
    source: `Archived draw ${ev.key} — placement bracket read match by match`,
  };
  for (const g of genders) {
    let d;
    try {
      d = derive(ev, draw, g);
    } catch (e) {
      if (!(e instanceof Refuse)) throw e;
      problems.push(`${ev.key} ${g}: ${e.message}`);
      continue;
    }
    meta.genders.push(g);
    if (d.unplaced.length) meta.unplaced[g] = d.unplaced;
    for (const r of d.rows) {
      const cc = COUNTRY[r.c];
      if (!cc) throw new Error(`unmapped country code ${r.c} in ${ev.key}`);
      rows.push({ ev: ev.key, g, c: r.c, iso: cc[0], name: cc[1], pos: r.pos, via: r.via });
    }
  }
  if (meta.genders.length) events.push(meta);
}

// Every code the page can render, placed or not, so the unplaced list gets a flag
// and a name too — and, more to the point, an ISO code, without which a click on
// one of them could not find that country's national ranking.
const used = new Set([...rows.map((r) => r.c), ...events.flatMap((e) => Object.values(e.unplaced).flat())]);
const countries = {};
for (const c of [...used].sort()) {
  if (!COUNTRY[c]) throw new Error(`unmapped country code ${c}`);
  countries[c] = { iso: COUNTRY[c][0], name: COUNTRY[c][1] };
}

const out = {
  updated: new Date().toISOString().slice(0, 10),
  note:
    "National-team championships, every nation. Each placing is read off the tournament's own placement bracket in the archived draw — FIP team events play every nation down to an exact position, so nothing here is estimated or inferred from a ranking. Editions whose draw does not state a result are listed as gaps rather than filled in.",
  events,
  countries,
  rows,
  gaps: GAPS,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");

const byEv = {};
for (const r of rows) byEv[`${r.ev} ${r.g}`] = (byEv[`${r.ev} ${r.g}`] || 0) + 1;
console.log(`wrote ${path.relative(ROOT, OUT)} — ${events.length} editions, ${rows.length} rows`);
for (const k of Object.keys(byEv).sort()) console.log(`  ${k}: ${byEv[k]} nations`);
for (const p of problems) console.log(`  GAP ${p}`);

// ------------------------------------------------------- --check: Denmark, 1:1
// Denmark's placings in the removed national-teams.json were sourced one by one
// (official draw / final classification / DPF) with no reference to this bracket
// walk. Reproducing them is the only independent evidence the walk is right.
if (process.argv.includes("--check")) {
  const EXPECT = [
    ["fip-135412", "women", 10],   // "World Championship 2024, women 10" (source: DPF)
    ["fip-296741", "men", 7],      // "Euro Padel Cup 2026, Junior, men 7" (source: DPF)
  ];
  let bad = 0;
  for (const [ev, g, pos] of EXPECT) {
    const r = rows.find((x) => x.ev === ev && x.g === g && x.c === "DEN");
    const got = r ? r.pos : "none";
    const ok = got === pos;
    if (!ok) bad++;
    console.log(`  check ${ev} ${g} DEN: expected ${pos}, derived ${got} ${ok ? "OK" : "MISMATCH"}`);
  }
  // Nations the draw says did not enter must not appear.
  const menWorld = rows.filter((r) => r.ev === "fip-135412" && r.g === "men").map((r) => r.c);
  if (menWorld.includes("DEN")) { console.log("  check: DEN must NOT appear in the 2024 men's world championship"); bad++; }
  else console.log("  check fip-135412 men DEN: absent OK (Denmark did not qualify)");
  // Positions must be a clean permutation per edition+gender.
  for (const k of Object.keys(byEv)) {
    const [ev, g] = k.split(" ");
    const ps = rows.filter((r) => r.ev === ev && r.g === g).map((r) => r.pos).sort((a, b) => a - b);
    const ok = ps.every((p, i) => p === i + 1);
    if (!ok) { console.log(`  check ${k}: positions are not 1..${ps.length} — ${ps.join(",")}`); bad++; }
  }
  if (bad) { console.error(`${bad} check(s) FAILED`); process.exit(1); }
  console.log("all checks passed");
}
