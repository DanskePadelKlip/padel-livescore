// Match-derived statistics shared by the player profile and the pair page.
//
// Both pages report titles, finals, form, sets and games over a list of a
// competitor's matches, and they MUST agree to the digit — a profile saying
// "62% sets won" next to a pair page saying 58% for the same run of matches is
// the kind of contradiction a reader notices and never trusts again. So the
// definitions live here once instead of being written out per route.
//
// Every function takes rows of the shape { round, score, side, win } ordered
// NEWEST FIRST, which is what both routes' queries already produce.
// (Filenames starting with "_" are not turned into routes by Cloudflare Pages.)

// "final" as a whole word, excluding semi-/quarter- and the 1/8-style labels.
// Deliberately conservative: RankedIn's `round` is usually a DRAW name
// ("Herrar C", "Grupp B", "Elimination"), not a round, so this recognises the
// rounds it can and silently ignores everything else rather than guessing.
export const isFinal = (r) => r && /\bfinals?\b/i.test(r) && !/semi|quarter|1\/[0-9]/i.test(r);

// A set score cell → games won. Games digit only, so a tie-break written "66"
// (6-6, won on the breaker) still counts as 6.
export const gameOf = (c) => {
  const m = /^([67])\d+$/.exec(String(c));
  return m ? +m[1] : (parseInt(c, 10) || 0);
};

export const pct = (w, l) => (w + l ? Math.round((w / (w + l)) * 100) : null);

// A score string is always written side-1-first. Wherever a score is printed next
// to ONE competitor's result — "Last: won 6-3 6-4" — it has to be read from that
// competitor's side, or a win from side 2 gets printed as "won 3-6 4-6". Cells
// that don't parse are passed through untouched rather than mangled.
export function scoreFrom(score, side) {
  if (!score || side !== 2) return score || "";
  return String(score).trim().split(/\s+/).map((set) => {
    const p = set.split("-");
    return p.length === 2 ? `${p[1]}-${p[0]}` : set;
  }).join(" ");
}

// Sets and games from the score strings. `side` says which half of "6-4" is
// ours, so this works unchanged for a pair (both players share a side).
export function setsAndGames(rows) {
  let setsWon = 0, setsLost = 0, gamesWon = 0, gamesLost = 0;
  for (const r of rows) {
    if (!r.score) continue;
    const mine = r.side === 1 ? 0 : 1;
    for (const set of String(r.score).trim().split(/\s+/)) {
      const p = set.split("-");
      if (p.length !== 2) continue;
      const my = gameOf(p[mine]), op = gameOf(p[1 - mine]);
      gamesWon += my; gamesLost += op;
      if (my > op) setsWon++; else if (op > my) setsLost++;
    }
  }
  return {
    sets: { won: setsWon, lost: setsLost, pct: pct(setsWon, setsLost) },
    games: { won: gamesWon, lost: gamesLost, pct: pct(gamesWon, gamesLost) },
  };
}

// One match's score read from OUR side: [{ my, op }] per set, [] when the row
// carries no parsable score (walkovers and retirements are stored score-less).
function setsOf(score, side) {
  if (!score) return [];
  const mine = side === 1 ? 0 : 1;
  const out = [];
  for (const set of String(score).trim().split(/\s+/)) {
    const p = set.split("-");
    if (p.length !== 2) continue;
    out.push({ my: gameOf(p[mine]), op: gameOf(p[1 - mine]) });
  }
  return out;
}

// HOW the wins and losses happened, not just how many. Everything here comes
// from score strings we already hold, so it covers the whole archive rather
// than the handful of events anyone ships point-by-point data for.
//
// Two deliberate conservatisms, both because a wrong stat is worse than none:
// - a match needs at least two parsed sets before it can be called straight
//   or a decider, so a retirement stored as "6-2" is counted in nothing;
// - "decider" means the sets were LEVEL going into the last one, which is what
//   makes it a decider. Reading it as "three sets were played" would count a
//   best-of-5 2-0 lead the same way, and some club formats are not best-of-3.
export function matchShape(rows) {
  const z = () => ({ w: 0, l: 0 });
  const out = {
    scored: 0,                 // matches with a readable score (the denominator)
    decider: z(),              // went to a level final set
    straight: z(),             // opponent (or we) took no set
    firstSetLost: z(),         // w = won after dropping the opener, l = lost from a set up
    tiebreakSets: z(),         // sets that finished 7-6 / 6-7
    bagel: { f: 0, a: 0 },     // 6-0 sets for / against
    breadstick: { f: 0, a: 0 },// 6-1 sets for / against
  };
  for (const r of rows) {
    const sets = setsOf(r.score, r.side);
    if (!sets.length) continue;
    out.scored++;
    const won = r.win === 1;
    const k = won ? "w" : "l";
    let mine = 0, theirs = 0;
    for (const s of sets) {
      if (s.my > s.op) mine++; else if (s.op > s.my) theirs++;
      if ((s.my === 7 && s.op === 6) || (s.my === 6 && s.op === 7)) out.tiebreakSets[s.my === 7 ? "w" : "l"]++;
      if (s.my === 6 && s.op === 0) out.bagel.f++;
      if (s.op === 6 && s.my === 0) out.bagel.a++;
      if (s.my === 6 && s.op === 1) out.breadstick.f++;
      if (s.op === 6 && s.my === 1) out.breadstick.a++;
    }
    if (sets.length < 2) continue;
    // level going into the last set = a decider
    let lm = 0, lt = 0;
    for (const s of sets.slice(0, -1)) { if (s.my > s.op) lm++; else if (s.op > s.my) lt++; }
    if (lm === lt) out.decider[k]++;
    if (won ? theirs === 0 : mine === 0) out.straight[k]++;
    const first = sets[0];
    if (first.op > first.my && won) out.firstSetLost.w++;
    if (first.my > first.op && !won) out.firstSetLost.l++;
  }
  return out;
}

// Elo -> a win chance, with the correction the raw formula needs.
//
// THE CALIBRATION. A rating is stored per player and a pair is their AVERAGE, so
// the plain 1/(1+10^(d/400)) halves the gap between two teams on the way in and
// comes out badly under-confident. Measured against the model's own 140,000
// stored predictions (padel-db, player_elo_fip_match): matches it called 70-80%
// were won 92% of the time, and everything it called >=65% came in at 90.1%
// against a predicted 73.8%. In logits the correction is 2.1-2.2 at both tails.
// It is not a tuning knob, it undoes the halving.
// Per POOL, because they were measured separately and differ: 2.15 on the FIP
// tour, 1.75 in the Nordic pool, each fitted to that pool's own stored
// predictions (padel-db, player_elo_*_match). Using the FIP figure on a Nordic
// pair overstates the favourite - which is what shipped yesterday.
export const ELO_CALIBRATION = { fip: 2.15, rin: 1.75 };
export const calibrationFor = (source) => ELO_CALIBRATION[source] || 1.9;

// A pair is NOT the average of its two players. Fitted over 184,536 Nordic and
// 35,329 FIP matches (padel-db/pair_shape.py), the best team function is
// mean + 0.45 * spread/2 - the same value in both pools independently, which is
// why it is believable. It matters most for a lopsided pair.
export const PAIR_SKEW = 0.45;
export const pairStrength = (a, b) => (a + b) / 2 + PAIR_SKEW * Math.abs(a - b) / 2;

// Win probability for a whole pair against a whole pair. Unlike the h2h case
// there is no imaginary shared partner here, so the full calibration applies.
export function pairOdds(A, B) {
  if (A.length !== 2 || B.length !== 2) return null;
  if (A.some((p) => !p) || B.some((p) => !p)) return null;
  const pools = [...A, ...B].map((p) => p.source + "/" + p.pool);
  if (new Set(pools).size !== 1) return { pct: null, caveat: "different rating pools" };
  const k = calibrationFor(A[0].source);
  const ra = pairStrength(A[0].rating, A[1].rating);
  const rb = pairStrength(B[0].rating, B[1].rating);
  const p = 1 / (1 + Math.pow(10, k * (rb - ra) / 400));
  const thin = [...A, ...B].some((x) => (x.n_matches || 0) < 20);
  return {
    pct: Math.min(99, Math.max(1, Math.round(p * 100))),
    caveat: thin ? "one of them has under 20 rated matches"
          : Math.abs(ra - rb) > 300 ? "gap beyond the calibrated range" : null,
  };
}

// Padel is doubles, so a rating gap between two individuals only becomes a win
// chance once you say what the rest of the court looks like. The honest framing
// is EQUAL PARTNERS: put the same player alongside each of them, and the pair
// averages differ by half the gap between the two.
//
// Note what that does: halving for the partner and multiplying by the 2.15
// calibration very nearly cancel (2.15/2 = 1.075), so this lands within a couple
// of points of the plain Elo formula on the two ratings. That is a coincidence
// of this particular framing, not a reason to drop either step -- a pair-vs-pair
// probability needs the full factor.
//
// Returns null when the two are not comparable. A FIP rating and a Nordic one
// are different scales, and men and women are rated separately, so a number
// across those would be meaningless rather than merely uncertain.
export function eloOdds(ea, eb) {
  if (!ea || !eb || ea.rating == null || eb.rating == null) return null;
  if (ea.source !== eb.source || ea.pool !== eb.pool)
    return { pct: null, caveat: "different rating pools - not comparable" };
  const gap = ea.rating - eb.rating;
  const pairGap = gap / 2;                       // an equal partner on each side
  const p = 1 / (1 + Math.pow(10, -calibrationFor(ea.source) * pairGap / 400));
  // Never render a certainty, and say so when the gap is past where the
  // calibration was actually measured (buckets from 20% to 90%).
  const pct = Math.min(99, Math.max(1, Math.round(p * 100)));
  const thin = Math.min(ea.n_matches || 0, eb.n_matches || 0) < 20;
  return {
    pct,
    caveat: thin ? "one of them has under 20 rated matches"
          : Math.abs(pairGap) > 300 ? "gap beyond the calibrated range" : null,
  };
}

// Recent form (newest first, capped) plus the current run of the same result.
export function formAndStreak(rows, cap = 12) {
  const form = rows.slice(0, cap).map((r) => (r.win === 1 ? "W" : "L"));
  let streak = 0;
  const s0 = rows[0]?.win;
  for (const r of rows) { if (r.win === s0) streak++; else break; }
  return { form, streak, streakType: s0 === 1 ? "W" : "L" };
}

// How deep in a draw a round label sits. Used ONLY for "best result", so it
// returns null for anything it does not positively recognise — across the
// archive most `round` values are draw names, and inventing a depth for
// "Herrar C" would put a fake "reached the final" on thousands of pair pages.
const ROUNDS = [
  [/\bq(?:ual|ualifying|ualification)?\s*\d*\b|\bqualification/i, 1, "qualifying"],
  [/round of 128|\b1\/64\b/i, 2, "round of 128"],
  [/round of 64|\b1\/32\b|\br64\b/i, 3, "round of 64"],
  [/round of 32|\b1\/16\b|\br32\b/i, 4, "round of 32"],
  [/round of 16|\b1\/8\b|\br16\b|\beighth\b/i, 5, "round of 16"],
  [/quarter\s*-?\s*finals?|\bqf\b|\b1\/4\b/i, 6, "quarter-final"],
  [/semi\s*-?\s*finals?|\bsf\b|\b1\/2\b/i, 7, "semi-final"],
];
export function roundRank(round) {
  const r = String(round || "");
  if (!r) return null;
  // A third-place play-off is not the final, however it is spelled.
  if (/3(?:rd|:e|e)?\s*(?:place|plats|plass|platz)/i.test(r)) return null;
  for (const [re, rank, label] of ROUNDS) if (re.test(r)) return { rank, label };
  if (isFinal(r)) return { rank: 8, label: "final" };
  return null;
}

// The deepest round this run of matches reached, or null when no row carried a
// round label we recognise. `won` is true only for a final that was won.
export function bestResult(rows) {
  let best = null;
  for (const r of rows) {
    const rr = roundRank(r.round);
    if (!rr) continue;
    if (!best || rr.rank > best.rank || (rr.rank === best.rank && r.win === 1 && !best.won)) {
      best = { rank: rr.rank, label: rr.label, won: r.win === 1, date: r.date || null, tournament: r.tournament || null };
    }
  }
  if (!best) return null;
  best.title = best.rank === 8 && best.won;
  return best;
}
