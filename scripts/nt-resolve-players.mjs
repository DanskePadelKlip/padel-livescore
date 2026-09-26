// Resolving a printed name to a player profile — the name join, kept honest.
//
// The draws print a player as the FIP abbreviation, "P. Hansen", and the national-
// teams section names 2,510 of them without one being clickable. Turning those into
// profile links is a NAME JOIN, which is the thing that puts the wrong person in a
// national team, so it happens here at build time under rules that refuse rather
// than guess, and every link is re-derivable by rerunning the build.
//
// THE INDEX IS STATIC, DELIBERATELY. `data/players-lite.json` is the whole
// searchable player list as an asset because **`/api/search` costs ~6,200 D1
// row-reads per query** — 2,510 of them is three times the daily free-tier cap and
// would take every D1-backed route on padelticker down until midnight UTC. Never
// resolve names through the API.
//
// TWO PASSES, THE SECOND NEEDS A SECOND WITNESS:
//
//  1. **Exact** — printed name + nation match a FIP-namespace row outright. This is
//     barely a join: a FIP id IS the slug of that abbreviated name, so the row and
//     the draw are saying the same thing. It inherits FIP's own identity model,
//     including that two people sharing an abbreviation upstream share one id — the
//     model the site's FIP profiles already use, not a new claim made here.
//  2. **Initial + surname** against the FULL names in the RankedIn namespace, which
//     is where the Nordic juniors and veterans live. This one IS an inference, so it
//     links only when the country leaves exactly ONE candidate *and* that candidate's
//     gender — read from the national ranking lists — matches the gender of the
//     matches the name actually played in. No ranking entry, no witness, no link.
//
// Both passes refuse a printed name that appears in BOTH men's and women's matches:
// two different people are sharing one abbreviation and nothing here separates them.
//
// The gender witness is not theoretical. "P. Hansen (DEN)" in the men's junior team
// resolves by initial and surname to **Pernille Hansen** — a real Danish player, the
// wrong person, in the exact place a Danish reader would notice. It is rejected.

import fs from "node:fs";

const deaccent = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[Øø]/g, "o").replace(/[Ææ]/g, "ae").replace(/[Åå]/g, "aa");
const nkey = (s) => deaccent(s).replace(/\s+/g, " ").trim().toLowerCase();
const ABBREV = /^([A-Za-zÀ-ÿ])\.(?:\s*[A-Za-zÀ-ÿ]\.)*\s+(.+)$/;

/**
 * @param matches   the rubber rows about to be published
 * @param countries IOC -> {iso,name}, for the ISO code the RankedIn namespace uses
 * @param litePath  data/players-lite.json
 * @param rankPath  data/rankings.json — gitignored, generated on the laptop, so on
 *                  any other checkout pass 2 simply makes no links
 */
export function resolvePlayers(matches, countries, litePath, rankPath) {
  const stats = { exact: 0, initial: 0, bothGenders: 0, noWitness: 0, genderClash: 0, unresolved: 0, index: false, witness: false };
  if (!fs.existsSync(litePath)) return { players: {}, stats };
  stats.index = true;
  const lite = JSON.parse(fs.readFileSync(litePath, "utf8"));

  const gender = new Map();
  if (fs.existsSync(rankPath)) {
    stats.witness = true;
    const rk = JSON.parse(fs.readFileSync(rankPath, "utf8"));
    for (const l of rk.lists || []) {
      const g = l.category === "women" ? "women" : "men";
      for (const row of l.rows || []) {
        if (!row.id) continue;
        gender.set(row.id, gender.has(row.id) && gender.get(row.id) !== g ? "both" : g);
      }
    }
  }

  // The FIP namespace carries IOC codes ("BEL"), the RankedIn namespace ISO-2 ("DK"),
  // in the same column of the same file. Keying one on the other silently matches
  // nothing at all — which is exactly what the first run of this did.
  const exact = new Map(), byInitial = new Map();
  const push = (map, k, v) => map.set(k, [...(map.get(k) || []), v]);
  for (const [id, name, country] of lite.players) {
    const cc = (country || "").toUpperCase();
    push(exact, `${nkey(name)}|${cc}`, id);
    if (ABBREV.test(name)) continue;
    const parts = nkey(name).split(" ");
    if (parts.length >= 2) push(byInitial, `${parts[0][0]}|${parts.slice(1).join(" ")}|${cc}`, id);
  }

  const seen = new Map();
  for (const m of matches) {
    for (const [name, c] of [...m.pa.map((n) => [n, m.a]), ...m.pb.map((n) => [n, m.b])]) {
      const k = `${name}|${c}`;
      const e = seen.get(k) || { genders: new Set() };
      e.genders.add(m.g);
      seen.set(k, e);
    }
  }

  const players = {};
  for (const [k, info] of seen) {
    const [name, ioc] = k.split("|");
    if (info.genders.size > 1) { stats.bothGenders++; stats.unresolved++; continue; }
    const [g] = [...info.genders];

    const hit = exact.get(`${nkey(name)}|${ioc}`) || [];
    if (hit.length === 1) { players[k] = hit[0]; stats.exact++; continue; }

    const ab = ABBREV.exec(name);
    const iso = (countries[ioc] || {}).iso;
    const cand = (ab && iso && byInitial.get(`${nkey(ab[1])}|${nkey(ab[2])}|${iso}`)) || [];
    if (cand.length !== 1) { stats.unresolved++; continue; }
    const cg = gender.get(cand[0]);
    if (!cg) { stats.noWitness++; stats.unresolved++; continue; }
    if (cg !== g) { stats.genderClash++; stats.unresolved++; continue; }
    players[k] = cand[0];
    stats.initial++;
  }
  return { players, stats };
}
