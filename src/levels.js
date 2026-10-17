// Tournament level: one global ladder used to sort the /map country view. Premier Padel
// and FIP come first, then each country's own top level down to club play.
//
// Lower rank = higher level. Ranks are only comparable inside a band: an NPT250, a DPF200
// and an LTA Grade 3 share rank 120 by judgement, not by any official equivalence.
//
// Signals, strongest first: FIP's own WordPress tier slug (tournament.level), then the
// event name, then the class names (Danish DPF levels live in the class names, e.g.
// "Herrer DPF200"), then a federation ranking attached by RankedIn.

export const BANDS = [
  [0, "Premier Padel"],
  [35, "FIP"],
  [100, "National top level"],
  [120, "National ranked"],
  [160, "Leagues"],
  [200, "Club and local"],
];
export const bandOf = (rank) => BANDS.filter(([min]) => rank >= min).pop()[1];

const FIP_SLUG = [
  [/ppt-major|premier-padel-major/, 10, "Major"],
  [/ppt-p1\b/, 20, "P1"],
  [/ppt-p2\b/, 30, "P2"],
  [/platinum/, 40, "FIP Platinum"],
  [/gold/, 50, "FIP Gold"],
  [/silver/, 60, "FIP Silver"],
  [/bronze/, 70, "FIP Bronze"],
  [/promotion/, 80, "FIP Promotion"],
  [/promises|junior/, 85, "FIP Promises"],
];

const DPF = { 500: 110, 200: 120, 100: 130, 60: 140, 35: 145, 25: 150, 10: 155 };
const NPT = { 1000: 100, 500: 110, 250: 120, 100: 130, 50: 140 };
const LTA = { 1: 100, 2: 110, 3: 120, 4: 130, 5: 150 };

/**
 * @param {{name?:string, level?:string, ranking?:string}} t  the tournament object
 * @param {string[]} classes  distinct class names seen in the feed for this tournament
 * @returns {{rank:number, label:string}}
 */
export function levelOf(t, classes = []) {
  const name = String(t?.name || "");
  const all = [name, ...classes].join(" | ");
  const hits = [];
  const add = (rank, label) => rank != null && hits.push({ rank, label });

  if (t?.level) for (const [re, rank, label] of FIP_SLUG) if (re.test(t.level)) { add(rank, label); break; }

  // Premier Padel and FIP by name (their class names are empty)
  if (/\bmajor\b/i.test(name) && /premier|padel/i.test(name)) add(10, "Major");
  if (/\bP1\b/.test(name)) add(20, "P1");
  if (/\bP2\b/.test(name)) add(30, "P2");
  if (/world cup|european (padel )?championship|nations/i.test(name)) add(35, "FIP nations");
  for (const [re, rank, label] of FIP_SLUG.slice(3)) if (new RegExp("FIP\\s+" + re.source, "i").test(name)) add(rank, label);

  // Denmark
  if (/DPF\s*2000|DPF\s*1000|Arla Protein Padel Series/i.test(all)) add(100, "DPF1000");
  if (/Elitedivision/i.test(all)) add(105, "Elitedivision");
  for (const m of all.matchAll(/DPF\s*\d{2,3}(?:\s*\/\s*\d{2,3})*/gi)) {
    const top = Math.max(...m[0].match(/\d{2,3}/g).map(Number));
    add(DPF[top], `DPF${top}`);
  }
  if (/ForeningsLiga/i.test(name)) add(160, "DPF league");

  // Sweden
  if (/SPT\s*(Elite|Master)/i.test(all)) add(100, "SPT Elite");
  if (/SPT\s*Challenger/i.test(all)) add(120, "SPT Challenger");
  if (/SPF Padel Ranking|Sanktionerade/i.test(all + " " + (t?.ranking || ""))) add(150, "SPF ranked");

  // Norway
  for (const m of all.matchAll(/NPT\s*(1000|500|250|100|50)\b/gi)) add(NPT[m[1]], `NPT${m[1]}`);

  // Great Britain
  for (const m of all.matchAll(/\bGrade\s*(\d)|\bG(\d)\b/gi)) {
    const g = +(m[1] || m[2]);
    add(LTA[g], `LTA G${g}`);
  }

  // Generic. DM/SM are matched case-sensitively and space-delimited: a JS \b treats
  // non-ASCII letters as boundaries, so /\bSM\b/i matched "Smíchov".
  if (/\bnationals\b|meisterschaft|national championship/i.test(name) || /(^|\s)(DM|SM)(\s|$)/.test(name)) {
    add(/gehörlos|deaf|\bpara\b/i.test(name) ? 165 : 115, "National champs");
  }
  if (/county/i.test(name)) add(140, "County");
  if (/liga|league|leauge|serie|division|divizia|extraliga/i.test(name)) add(160, "League");
  if (t?.ranking && !/no ranking/i.test(t.ranking)) add(170, "Ranked");

  return hits.sort((a, b) => a.rank - b.rank)[0] || { rank: 200, label: "Club" };
}
