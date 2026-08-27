// GET /og/match/... — dynamic Open Graph image for a single match.
import { ogResponse, matchCardSvg, fallbackCardSvg } from "../../_og.js";
import { findMatch, parseMatchPath, teamLabel, scoreLabel } from "../../_matchkey.js";

export async function onRequestGet(ctx) {
  const origin = new URL(ctx.request.url).origin;
  const q = parseMatchPath(ctx.params.path || []);
  const found = q ? await findMatch(origin, q) : null;

  if (!found) return ogResponse(ctx, fallbackCardSvg());
  const { match: m, tournament: t } = found;
  return ogResponse(ctx, matchCardSvg({
    a: teamLabel(m.teams[0]),
    b: teamLabel(m.teams[1]),
    score: scoreLabel(m),
    winner: m.score && m.score.winner != null ? m.score.winner : null,
    sub: [t.name, m.round].filter(Boolean).join(" · "),
    live: m.status === "live",
  }));
}
