// GET /tournament/:source/:id — app shell with this tournament's meta injected.
import { SITE, shell, withMeta } from "../../_shared.js";

export async function onRequestGet({ request, params }) {
  const origin = new URL(request.url).origin;
  const source = params.source;
  const id = params.id;
  const base = await shell(origin);

  let name = null, fed = "", start = null, end = null;

  // Archive tournaments have a static file keyed "source-id".
  try {
    const r = await fetch(origin + `/data/archive/t/${source}-${id}.json`, { cf: { cacheTtl: 0 } });
    if (r.ok) {
      const d = await r.json();
      name = d.name; fed = d.federation || ""; start = d.start; end = d.end;
    }
  } catch {}

  // Otherwise it's a live tournament — find it in the current feed.
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

  if (!name) return base; // unknown → generic shell

  const title = `${name} — draw, results & schedule · PadelTicker`;
  const description =
    `${name}${fed ? ` (${fed})` : ""} — live scores, the full draw, results and schedule on PadelTicker.`;
  const canonical = `${SITE}/tournament/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;

  const jsonld = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name,
    sport: "Padel",
    url: canonical,
    ...(start ? { startDate: start } : {}),
    ...(end ? { endDate: end } : {}),
  };

  const image = `${SITE}/og/tournament/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
  return withMeta(base, { title, description, canonical, ogType: "website", image, jsonld });
}
