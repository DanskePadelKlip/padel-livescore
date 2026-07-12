// Normalized match schema — the single shape every adapter must output.
// The frontend and the aggregate layer ONLY ever see this shape, never a
// source-specific payload. Adding a new federation = one new adapter that
// emits this; nothing downstream changes.

export const STATUS = Object.freeze({
  LIVE: "live",
  UPCOMING: "upcoming",
  FINAL: "final",
});

// Globally-unique id across all sources, e.g. "rankedin:2516013".
export const gid = (source, nativeId) => `${source}:${nativeId}`;

/**
 * @typedef {Object} NormalizedMatch
 * @property {string} id          gid(source, nativeId) — globally unique
 * @property {string} source      adapter id, e.g. "rankedin"
 * @property {string} federation  country/federation code, e.g. "DK"
 * @property {{id:number|string,name:string,url:string}} tournament
 * @property {string|null} className  category text, e.g. "Herrer"
 * @property {string|null} round      draw/group/round text
 * @property {string|null} court
 * @property {"live"|"upcoming"|"final"} status
 * @property {string|null} startTime  ISO 8601, or null if unknown
 * @property {Team[]} teams           always length 2 (side A, side B)
 * @property {Score} score
 * @property {Object} [raw]           optional source fields kept for debugging/calibration
 *
 * @typedef {Object} Team
 * @property {string} name            display label ("A. Nord / B. Sud" or club name)
 * @property {Player[]} players
 *
 * @typedef {Object} Player
 * @property {string} name
 * @property {string|null} country    ISO-ish short code
 *
 * @typedef {Object} Score
 * @property {Array<[number|string, number|string]>} sets  per-set [sideA, sideB]
 * @property {0|1|null} winner        0 = side A, 1 = side B, null = undecided
 */

// Lightweight shape guard — throws in dev if an adapter emits something off.
export function assertMatch(m) {
  if (!m || typeof m !== "object") throw new Error("match must be an object");
  if (!m.id || !m.source) throw new Error(`match missing id/source: ${JSON.stringify(m).slice(0, 120)}`);
  if (!Object.values(STATUS).includes(m.status)) throw new Error(`bad status "${m.status}" on ${m.id}`);
  if (!Array.isArray(m.teams) || m.teams.length !== 2) throw new Error(`match ${m.id} must have exactly 2 teams`);
  return m;
}
