// GET /og/pair/:a/:b — dynamic Open Graph image for a partnership.
import { ogResponse, pairCardSvg, fallbackCardSvg } from "../../../_og.js";

export async function onRequestGet(ctx) {
  const { request, params } = ctx;
  const origin = new URL(request.url).origin;

  let svg = null;
  try {
    const r = await fetch(
      origin + "/api/pair/" + encodeURIComponent(params.a) + "/" + encodeURIComponent(params.b)
    );
    const d = r.ok ? await r.json() : null;
    if (d && d.players) {
      const { a, b } = d.players;
      const s = d.summary || {};
      const cc = [a.country, b.country].filter(Boolean).map((c) => String(c).toUpperCase()).join(" · ");
      const bits = [];
      if (s.total) {
        bits.push(`${s.total} together`);
        bits.push(`${s.wins}–${s.losses}`);
        bits.push(`${Math.round((s.wins / s.total) * 100)}% win rate`);
      } else {
        bits.push("padel partnership");
      }
      svg = pairCardSvg({ a: a.name, b: b.name, countries: cc, stats: bits.join("  ·  ") });
    }
  } catch {}

  return ogResponse(ctx, svg || fallbackCardSvg());
}
