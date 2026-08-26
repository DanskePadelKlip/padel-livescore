// Meta for the site's top-level section pages (/results, /players, /rankings, /events).
//
// These are real SPA routes and they are in sitemap.xml, but they had no Function of
// their own — so they were served the raw app shell, whose canonical is hardcoded to the
// homepage. That told Google "index this" and "this page is really the homepage" at the
// same time, and Search Console duly dropped all four as "Alternativ side med korrekt
// kanonisk tag" (2026-07-29). They are the crawl paths into ~5,300 entity URLs, so losing
// them wastes the whole hub layer.
//
// Each route now gets a self-canonical plus its own title/description, exactly like the
// entity pages. Keep this list in step with the routes emitted by sitemap.xml.js.
import { SITE, shell, withMeta } from "./_shared.js";

const HUBS = {
  results: {
    name: "Results",
    title: "Padel results — every finished match, all federations · PadelTicker",
    description:
      "Finished padel matches from every federation we cover, newest first — scores, draws and tournaments, updated continuously.",
  },
  players: {
    name: "Players",
    title: "Padel players — profiles, results & head-to-head · PadelTicker",
    description:
      "Browse padel players across every federation: match history, head-to-head records, rankings and the tournaments they played.",
  },
  rankings: {
    name: "Rankings",
    title: "Padel rankings — FIP world and national lists · PadelTicker",
    description:
      "Padel ranking lists: the FIP world ranking plus national men's and women's rankings, with live points and weekly movement.",
  },
  events: {
    name: "Events",
    title: "Padel tournaments — live, upcoming & finished · PadelTicker",
    description:
      "Padel tournaments from every federation we cover — live now, coming up, and recently finished, with draws and full results.",
  },
};

/**
 * Build the onRequestGet handler for one hub route.
 * @param {keyof HUBS} key
 */
export function hub(key) {
  return async function onRequestGet({ request }) {
    const origin = new URL(request.url).origin;
    const base = await shell(origin);
    const h = HUBS[key];
    if (!h) return base; // unknown key → generic shell rather than a wrong canonical

    const canonical = `${SITE}/${key}`;
    const jsonld = [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: h.name,
        url: canonical,
        description: h.description,
        isPartOf: { "@type": "WebSite", name: "PadelTicker", url: SITE + "/" },
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "PadelTicker", item: SITE + "/" },
          { "@type": "ListItem", position: 2, name: h.name, item: canonical },
        ],
      },
    ];

    return withMeta(base, {
      title: h.title,
      description: h.description,
      canonical,
      ogType: "website",
      jsonld,
    });
  };
}
