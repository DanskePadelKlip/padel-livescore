// GET /tournament/:source/:id — app shell with this tournament's meta injected.
import { SITE, shell, withMeta } from "../../_shared.js";

export async function onRequestGet({ request, params }) {
  const origin = new URL(request.url).origin;
  const source = params.source;
  const id = params.id;
  const base = await shell(origin);

  let name = null, fed = "", start = null, end = null, venue = null, address = null;
  let organizer = null, organizerUrl = null;

  // Archive tournaments have a static file keyed "source-id".
  try {
    const r = await fetch(origin + `/data/archive/t/${source}-${id}.json`, { cf: { cacheTtl: 0 } });
    if (r.ok) {
      const d = await r.json();
      name = d.name; fed = d.federation || ""; start = d.start; end = d.end;
      venue = d.venue || null; address = d.address || null;
      organizer = d.organizer || null; organizerUrl = d.organizerUrl || null;
    }
  } catch {}

  // Otherwise it's a live tournament — find it in the current feed.
  if (!name) {
    try {
      const r = await fetch(origin + "/data/matches.json", { cf: { cacheTtl: 0 } });
      if (r.ok) {
        const d = await r.json();
        const m = (d.matches || []).find((x) => x.source === source && String(x.tournament.id) === String(id));
        if (m) {
          const t = m.tournament;
          name = t.name; fed = m.federation || "";
          start = t.start || null; end = t.end || null;
          venue = t.venue || null; address = t.address || null;
          organizer = t.organizer || null; organizerUrl = t.organizerUrl || null;
        }
      }
    } catch {}
  }

  if (!name) return base; // unknown → generic shell

  const title = `${name} — draw, results & schedule · PadelTicker`;
  const description =
    `${name}${fed ? ` (${fed})` : ""} — live scores, the full draw, results and schedule on PadelTicker.`;
  const canonical = `${SITE}/tournament/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
  const image = `${SITE}/og/tournament/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;

  const jsonld = [
    {
      "@context": "https://schema.org",
      "@type": "SportsEvent",
      name,
      sport: "Padel",
      url: canonical,
      description,
      image,
      eventStatus: "https://schema.org/EventScheduled",
      // Both-or-nothing: an organiser without a URL is the incomplete `organizer` Google
      // flagged (GSC, 2026-07-27), and the old `|| fed` fallback published the federation
      // CODE ("SE") as an organisation name. Omitting is correct when we don't know.
      ...((organizer && organizerUrl)
        ? { organizer: { "@type": "Organization", name: organizer, url: organizerUrl } }
        : {}),
      ...((venue || address) ? { location: { "@type": "Place", name: venue || address, ...(address ? { address } : {}) } } : {}),
      ...(start ? { startDate: start } : {}),
      ...(end ? { endDate: end } : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "PadelTicker", item: SITE + "/" },
        { "@type": "ListItem", position: 2, name: "Results", item: SITE + "/results" },
        { "@type": "ListItem", position: 3, name, item: canonical },
      ],
    },
  ];

  return withMeta(base, { title, description, canonical, ogType: "website", image, jsonld });
}
