// GET /og/player/:id — dynamic Open Graph image for a player.
import { ogResponse, playerCardSvg, fallbackCardSvg } from "../../_og.js";

export async function onRequestGet(ctx) {
  const { request, params } = ctx;
  const origin = new URL(request.url).origin;

  let svg = null;
  try {
    const r = await fetch(origin + "/api/player/" + encodeURIComponent(params.id));
    const d = r.ok ? await r.json() : null;
    if (d && d.player) {
      const p = d.player, s = d.summary || {};
      const cc = p.country ? String(p.country).toUpperCase() : "";
      const bits = [];
      if (s.total) {
        bits.push(`${s.total} matches`);
        bits.push(`${s.wins}–${s.losses}`);
        bits.push(`${Math.round((s.wins / s.total) * 100)}% win rate`);
      }
      svg = playerCardSvg({ name: p.name, country: cc, stats: bits.join("  ·  ") });
    }
  } catch {}

  return ogResponse(ctx, svg || fallbackCardSvg());
}
