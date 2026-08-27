// Match link keys, shared by /match/* (meta) and /og/match/* (share image).
//
// MUST STAY IN SYNC with the block of the same name in public/app.js — the client
// builds these keys and the edge resolves them, and there is no build step that
// could share one copy. If you change the derivation, change both.
//
// Why derive rather than store: the live feed gives every match an adapter id, but
// the archive files (public/data/archive/t/*.json) hold only teams/round/score, so
// an id-based link would break the moment a tournament left the live feed — exactly
// when a result is worth sharing. Surnames + round, diacritic-folded, because FIP
// respells players between polls and a shared link has to survive that.
//
// (Filenames starting with "_" are not turned into routes by Cloudflare Pages.)

const DRAW_MARKER = /\s*(\((?:\d+|WC|Q|LL|SE|A)(?:\s*-\s*\w+)?\))\s*$/i;

const normName = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

export const slugPart = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const surnameKey = (name) => {
  const n = String(name || "").replace(DRAW_MARKER, "").trim();
  const initial = /^\S\.\s+(.+)$/.exec(n);
  if (initial) return normName(initial[1]);
  const toks = n.split(/\s+/);
  return normName(toks.length > 1 ? toks.slice(1).join(" ") : n);
};

export const teamKey = (t) => {
  const ps = (t.players || []).length ? t.players.map((p) => p.name) : String(t.name || "").split("/");
  return ps.map(surnameKey).filter(Boolean).join("-") || "tbd";
};

export const matchKey = (m) => `${teamKey(m.teams[0])}-vs-${teamKey(m.teams[1])}`;
export const matchRouteKey = (m) => `${slugPart(m.round) || "-"}/${matchKey(m)}`;

// [source, ...tournamentId, round, pair] — the last two segments are always round
// and pair, so an id containing a slash still parses.
export function parseMatchPath(seg) {
  if (!Array.isArray(seg) || seg.length < 4) return null;
  const source = seg[0];
  const pair = seg[seg.length - 1];
  const round = seg[seg.length - 2];
  const id = seg.slice(1, -2).join("/");
  if (!source || !id || !pair) return null;
  return { source, id, round, pair, key: `${round}/${pair}` };
}

// Resolve a parsed path to a match, preferring the archive (a finished tournament is
// the common case for a shared link) and falling back to the live feed.
//
// THE PAIR IS THE KEY; THE ROUND IS ONLY A TIE-BREAKER. That order matters: FIP's
// live feed carries the class inside the round ("Men Round of 32", className null)
// while its archive splits them (className "Men", round "Round of 32"), so a link
// copied during a tournament has a different round segment from the same match once
// archived — which is precisely when someone opens it. Measured 2026-08-27 over
// 39,499 archived matches: the pair alone is unique within its tournament for 99.90%
// of them, so leading with it costs almost nothing and saves every such link.
export async function findMatch(origin, q) {
  const pick = (list) => {
    const cands = list.filter((m) => matchKey(m) === q.pair);
    if (cands.length === 1) return cands[0];
    if (!cands.length) return null;
    // Same pair twice in one event (qualifying then main draw, or a group replay).
    // Tolerate the class prefix above by accepting either round as a suffix of the other.
    const r = q.round || "";
    return cands.find((m) => matchRouteKey(m) === q.key)
      || cands.find((m) => { const x = slugPart(m.round); return x && r && (x.endsWith(r) || r.endsWith(x)); })
      || null;
  };

  try {
    const r = await fetch(origin + `/data/archive/t/${q.source}-${q.id}.json`, { cf: { cacheTtl: 0 } });
    if (r.ok) {
      const d = await r.json();
      const m = pick(d.matches || []);
      if (m) return { match: m, tournament: { name: d.name, federation: d.federation || "", start: d.start, end: d.end } };
    }
  } catch {}

  try {
    const r = await fetch(origin + "/data/matches.json", { cf: { cacheTtl: 0 } });
    if (r.ok) {
      const d = await r.json();
      const ms = (d.matches || []).filter((x) => x.source === q.source && String(x.tournament.id) === String(q.id));
      const m = pick(ms);
      if (m) return { match: m, tournament: { name: m.tournament.name, federation: m.federation || "", start: null, end: null } };
    }
  } catch {}

  return null;
}

// "A. Coello / M. Tapia vs J. Lebron / A. Galan"
export const teamLabel = (t) => (t.name || (t.players || []).map((p) => p.name).join(" / ") || "TBD");
export const matchLabel = (m) => `${teamLabel(m.teams[0])} vs ${teamLabel(m.teams[1])}`;

// "6–3, 4–6, 7–5" — plain text, tie-break points folded in the way the app shows them.
export function scoreLabel(m) {
  const sets = (m.score && m.score.sets) || [];
  const cell = (v) => { const x = String(v == null ? "" : v); const t = /^([67])(\d+)$/.exec(x); return t ? `${t[1]}(${t[2]})` : x; };
  return sets.filter((s) => s && (s[0] || s[1])).map((s) => `${cell(s[0])}–${cell(s[1])}`).join(", ");
}
