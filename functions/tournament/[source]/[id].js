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
        const ms = (d.matches || []).filter((x) => x.source === source && String(x.tournament.id) === String(id));
        if (ms.length) {
          const t = ms[0].tournament;
          name = t.name; fed = ms[0].federation || "";
          start = t.start || null; end = t.end || null;
          venue = t.venue || null; address = t.address || null;
          organizer = t.organizer || null; organizerUrl = t.organizerUrl || null;
          // Only rankedin publishes tournament-level dates. Without a fallback the
          // other sources shipped an Event with no startDate, which Google rejects
          // outright (GSC, 2026-08-12). Match times are the next best source, and
          // ISO 8601 sorts lexicographically so min/max needs no date parsing.
          if (!start) {
            const times = ms.map((x) => isoDate(x.startTime)).filter(Boolean).sort();
            if (times.length) { start = times[0]; end = times[times.length - 1]; }
            else { const d2 = fipPlayDates(ms, id); if (d2) { start = d2.start; end = d2.end; } }
          }
        }
      }
    } catch {}
  }

  if (!name) return base; // unknown → generic shell

  // Whatever the source said, only a well-formed date reaches the markup.
  start = isoDate(start);
  end = isoDate(end);

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
      startDate: start,
      endDate: (end && end >= start) ? end : start,
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

  // An Event without startDate is an error on every such page; no Event at all
  // just forgoes the rich result. The BreadcrumbList is unaffected either way.
  const graphs = start ? jsonld : jsonld.filter((g) => g["@type"] !== "SportsEvent");

  return withMeta(base, { title, description, canonical, ogType: "website", image, jsonld: graphs });
}

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

// FIP matches carry no startTime - the order-of-play widget only labels each play
// day "AUG 12 WED". The year is in the tournament id ("FIP-2026-3401"), and day.n
// gives the true play order, so a tournament running Dec->Jan rolls the year over.
export function fipPlayDates(ms, id) {
  const year = Number((String(id).match(/-(\d{4})-/) || [])[1]);
  if (!year) return null;

  const days = [];
  for (const m of ms) {
    const p = String(m.day?.label || "").match(/([A-Z]{3})\s+(\d{1,2})/i);
    const mo = p && MONTHS[p[1].toUpperCase()];
    if (!mo) continue;
    days.push({ n: Number(m.day.n) || 0, mo, d: Number(p[2]) });
  }
  if (!days.length) return null;

  days.sort((a, b) => a.n - b.n);
  const pad = (n) => String(n).padStart(2, "0");
  let y = year, prevMo = days[0].mo;
  const dates = days.map((x) => {
    if (x.mo < prevMo) y++; // month went backwards -> crossed into the next year
    prevMo = x.mo;
    return `${y}-${pad(x.mo)}-${pad(x.d)}`;
  });
  return { start: dates[0], end: dates[dates.length - 1] };
}

// Accept "2026-08-12" or "2026-08-12T09:30(:00)", padding a single-digit hour;
// reject anything else rather than publish a date Google will refuse.
function isoDate(v) {
  const s = String(v || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return `${m[1]}T${m[2].padStart(2, "0")}:${m[3]}:${m[4] || "00"}`;
}
