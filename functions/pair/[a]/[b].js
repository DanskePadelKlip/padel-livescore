// GET /pair/:a/:b — app shell with this partnership's meta injected for scrapers.
//
// The two ids are interchangeable, so the route CANONICALISES to sorted order and
// 301s anything else there. Without that, /pair/A/B and /pair/B/A are two URLs
// serving one page — duplicate content that splits whatever ranking the page
// earns, and two entries for one pair in anyone's index.
import { SITE, shell, withMeta, pairMeta } from "../../_shared.js";

const seg = (s) => encodeURIComponent(String(s));

export async function onRequestGet({ request, params, env }) {
  const url = new URL(request.url);
  const a = params.a, b = params.b;
  if (!a || !b) return shell(url.origin);
  if (a === b) return Response.redirect(`${SITE}/player/${seg(a)}`, 301);
  if (a > b) return Response.redirect(`${SITE}/pair/${seg(b)}/${seg(a)}${url.search}`, 301);

  const base = await shell(url.origin);
  const d = await pairMeta(env, a, b);
  if (!d) return base; // unknown id, or D1 down -> generic shell (SPA still works)

  const s = d.summary || {};
  const pairName = `${d.a.name} / ${d.b.name}`;
  const wl = s.total ? `${s.wins}–${s.losses}` : null;          // en-dash
  const pct = s.total ? Math.round((s.wins / s.total) * 100) : null;

  const bits = [];
  if (s.total) bits.push(`${s.total} match${s.total === 1 ? "" : "es"} together`);
  if (wl) bits.push(`${wl} W–L`);
  if (pct != null) bits.push(`${pct}% win rate`);

  const title = `${pairName} — padel pair record, rivals & results · PadelTicker`;
  const description =
    (bits.length
      ? `${pairName} — ${bits.join(" · ")}. `
      : `${pairName} — this padel partnership has no recorded matches together yet. `) +
    `Every match ${d.a.name} and ${d.b.name} have played as a pair, their rivals and results on PadelTicker.`;
  const canonical = `${SITE}/pair/${seg(a)}/${seg(b)}`;

  const person = (p) => ({
    "@type": "Person",
    name: p.name,
    url: `${SITE}/player/${seg(p.id)}`,
    ...(p.country ? { nationality: String(p.country).toUpperCase() } : {}),
  });

  const jsonld = [
    {
      "@context": "https://schema.org",
      // A padel pair is a two-person team, which is exactly what SportsTeam
      // models — athlete[] carries the members and links both profile pages.
      "@type": "SportsTeam",
      name: pairName,
      url: canonical,
      sport: "Padel",
      athlete: [person(d.a), person(d.b)],
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "PadelTicker", item: SITE + "/" },
        { "@type": "ListItem", position: 2, name: "Pairs", item: SITE + "/pairs" },
        { "@type": "ListItem", position: 3, name: pairName, item: canonical },
      ],
    },
  ];

  const image = `${SITE}/og/pair/${seg(a)}/${seg(b)}`;
  return withMeta(base, { title, description, canonical, image, jsonld });
}
