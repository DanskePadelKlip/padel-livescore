// GET /og/tournament/:source/:id — dynamic Open Graph image for a tournament.
import { ogResponse, tournamentCardSvg, tournamentSub, fallbackCardSvg } from "../../../_og.js";

export async function onRequestGet(ctx) {
  const { request, params } = ctx;
  const origin = new URL(request.url).origin;
  const { source, id } = params;

  let name = null, fed = "", start = null, end = null;

  // Archive tournaments have a static file keyed "source-id".
  try {
    const r = await fetch(origin + `/data/archive/t/${source}-${id}.json`, { cf: { cacheTtl: 0 } });
    if (r.ok) { const d = await r.json(); name = d.name; fed = d.federation || ""; start = d.start; end = d.end; }
  } catch {}

  // Otherwise it's live — find it in the current feed.
  if (!name) {
    try {
      const r = await fetch(origin + "/data/matches.json", { cf: { cacheTtl: 0 } });
      if (r.ok) {
        const d = await r.json();
        const m = (d.matches || []).find((x) => x.source === source && String(x.tournament.id) === String(id));
        if (m) { name = m.tournament.name; fed = m.federation || ""; }
      }
    } catch {}
  }

  const svg = name
    ? tournamentCardSvg({ name, fed, sub: tournamentSub(start, end) })
    : fallbackCardSvg();
  return ogResponse(ctx, svg);
}
