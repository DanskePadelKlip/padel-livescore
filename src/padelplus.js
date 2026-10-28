// Padel+ (padelplus.app) hall scoring — read side.
//
// WHAT IT IS. Padel+ is a Danish club/league app. Some halls score Lunar Liga rubbers on
// it point by point (a tablet per court). Padel+ agreed (Kim, 2026-10-28) that we read it.
// Each rubber is ONE row in their Supabase table `lunar_live_delkampe`, rewritten on every
// tap: the row holds only the CURRENT score, and `version` goes up by one per tap. So a
// point history exists only if someone keeps every version — that is what
// scripts/capture-padelplus.mjs does, and why its timestamps are the row's own
// `updated_at` (the moment the hall tapped), not the moment we happened to poll.
//
// KEYS. `rankedin_match_id` is the RankedIn TIE id (the same id rankedin-teamleague.js
// uses for `rankedin-teamleague:<tie>`). `position` is 0-based, but it is NOT reliably
// RankedIn's rubber order: on tie 152684 (3 Oct) positions 1/2 held RankedIn's Kamp 3/2.
// Nothing here maps a position onto a RankedIn rubber; the capture files keep the raw
// position (`p<n>`) so a human or a later join decides.
//
// READS ONLY, with the public anon key their own /live page ships. The table grants anon
// SELECT on a column list only — `select=*` answers "permission denied for table" — so
// COLS below is exactly what their page asks for.

export const COLS = "kampdag_id,rankedin_match_id,position,format,court_label,phase,state,version,winner,updated_at,claimed_at,finished_at,godkendt_at,tastning";

const SITE = "https://padelplus.app/";
const REQ_TIMEOUT_MS = 15_000;
const KEY_TTL_MS = 24 * 3600_000;

let cfg = null; // { url, key, at }

/**
 * Supabase URL + anon key. Taken from env when set, else read off padelplus.app's own
 * bundle (what their page uses), so a key rotation on their side heals itself here.
 */
export async function config({ force = false } = {}) {
  if (process.env.PADELPLUS_SUPABASE_URL && process.env.PADELPLUS_ANON_KEY) {
    return { url: process.env.PADELPLUS_SUPABASE_URL, key: process.env.PADELPLUS_ANON_KEY };
  }
  if (!force && cfg && Date.now() - cfg.at < KEY_TTL_MS) return cfg;
  const html = await text(SITE);
  const js = /src="(\/assets\/index-[\w-]+\.js)"/.exec(html);
  if (!js) throw new Error("padelplus.app: no index bundle in the page");
  const bundle = await text(new URL(js[1], SITE).href);
  const url = (/https:\/\/[a-z0-9]{20}\.supabase\.co/.exec(bundle) || [])[0];
  const key = [...bundle.matchAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g)].map((m) => m[0])
    .find((k) => { try { return JSON.parse(Buffer.from(k.split(".")[1], "base64url")).role === "anon"; } catch { return false; } });
  if (!url || !key) throw new Error("padelplus.app: Supabase url/anon key not found in the bundle");
  cfg = { url, key, at: Date.now() };
  return cfg;
}

async function text(url) {
  const res = await fetch(url, { headers: { "User-Agent": "PadelTicker (padelticker.com)" }, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * Rubber rows touched since `sinceIso`, oldest first. Throws on HTTP failure. One row per
 * rubber, so 1000 is ~160 ties; asked newest-first so a cut drops the oldest, not the live.
 */
export async function fetchRows(sinceIso) {
  let c = await config();
  const q = `select=${COLS}&updated_at=gte.${encodeURIComponent(sinceIso)}&order=updated_at.desc&limit=1000`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${c.url}/rest/v1/lunar_live_delkampe?${q}`, {
      headers: { apikey: c.key, Authorization: `Bearer ${c.key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    // A rotated key answers 401: re-read it from their bundle once, then give up.
    if (res.status === 401 && attempt === 0 && !process.env.PADELPLUS_ANON_KEY) { c = await config({ force: true }); continue; }
    if (!res.ok) throw new Error(`lunar_live_delkampe HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("lunar_live_delkampe: answer is not a list");
    return rows.reverse();
  }
}

/** The overview their /live page shows: today's and this week's Lunar ties + tournaments. */
export async function fetchOverview() {
  const c = await config();
  const res = await fetch(`${c.url}/functions/v1/live-feed`, {
    method: "POST",
    headers: { apikey: c.key, Authorization: `Bearer ${c.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ view: "oversigt" }),
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`live-feed HTTP ${res.status}`);
  return res.json();
}

// ---- board state ------------------------------------------------------------

const GAME = ["0", "15", "30", "40"];

/**
 * Point labels for one side pair. In a game: 0/15/30/40, and past deuce "AD" for the side
 * one ahead (advantage and star point keep counting; golden point never gets there).
 * In a tiebreak / match tiebreak the counts themselves.
 */
export function pointLabels(state) {
  const [h, a] = state.points || [0, 0];
  if (state.mode !== "game") return [String(h), String(a)];
  if (h >= 3 && a >= 3) return h === a ? ["40", "40"] : h > a ? ["AD", "40"] : ["40", "AD"];
  return [GAME[Math.min(h, 3)], GAME[Math.min(a, 3)]];
}

/**
 * Sets each side has won. The last cell of state.sets is the set in play until the
 * rubber has a winner; a finished rubber's cells are all complete.
 */
export function setsWon(state) {
  const sets = state.sets || [];
  const done = state.winner === 0 || state.winner === 1 ? sets : sets.slice(0, -1);
  const won = [0, 0];
  for (const [h, a] of done) if (h !== a) won[h > a ? 0 : 1]++;
  return won;
}

/**
 * One rubber row -> the 5 board columns scoreboard-tools/poll_live.py writes after its
 * timestamp: sets won "h:a", every set "h-a,..." (the one in play included), current
 * game "h:a", serving side, status. Status "4" = finished (what timeline_from_live.py
 * looks for), "2" = in play. Serving is OUR convention: "1" home, "2" away.
 */
export function boardCols(row) {
  const s = row.state || {};
  const [wh, wa] = setsWon(s);
  const sets = (s.sets || []).map(([h, a]) => `${h}-${a}`).join(",");
  const [ph, pa] = pointLabels(s);
  const finished = row.phase === "done" || s.winner === 0 || s.winner === 1;
  return [`${wh}:${wa}`, sets, `${ph}:${pa}`, s.server === 1 ? "2" : "1", finished ? "4" : "2"];
}

/** poll_live.py's timestamp: python isoformat with "+00:00", never "Z". */
export const stamp = (iso) => new Date(iso).toISOString().replace("Z", "+00:00");

export const rubberKey = (row) => `${row.rankedin_match_id}:p${row.position}`;

/**
 * What to append for a batch of rows, given the last version kept per rubber (`last`,
 * key -> version; updated in place). Returns [{ key, row, lines }] for every rubber with
 * a version we have not kept. Lines are TSV rows plus `#` comments, which
 * timeline_from_live.py skips:
 *   - `# start ...`   the first version we ever see of a rubber (court, format, mode)
 *   - `# gap vA->vB`  versions we never saw: those taps' times are lost
 *   - `# back vA->vB` the version went DOWN (their undo); the row is still written
 */
export function diffRows(last, rows) {
  const out = [];
  for (const row of rows) {
    if (!row || row.rankedin_match_id == null || row.position == null || !row.state) continue;
    const key = rubberKey(row);
    const v = Number(row.version);
    const prev = last.get(key);
    if (prev === v) continue;
    const lines = [];
    if (prev == null) {
      lines.push(`# ${stamp(row.updated_at)} start tie ${row.rankedin_match_id} p${row.position}` +
        ` | court ${row.court_label || "?"} | kampdag ${row.kampdag_id} | tastning ${row.tastning || "?"}` +
        ` | format ${JSON.stringify(row.format || {})} | first seen v${v}`);
    } else if (v > prev + 1) lines.push(`# gap v${prev}->v${v}`);
    else if (v < prev) lines.push(`# back v${prev}->v${v}`);
    lines.push([stamp(row.updated_at), ...boardCols(row)].join("\t"));
    last.set(key, v);
    out.push({ key, row, lines });
  }
  return out;
}
