// GET /earnings/<men|women>[/<year|all>] — the earnings section's filter slices.
//
// Same reason as national-teams/[[path]].js: without a Function these fell through to
// the app shell, whose canonical is the homepage — "index this" and "this is really the
// homepage" at once, which is what dropped the hub pages in 2026-07 (see _hubs.js).
// /earnings/men and /earnings/women ARE in sitemap.xml, so they were pointing their
// canonical away from themselves; the per-year slices are not listed and canonicalise
// up to their gender page, which is the honest answer — they are the same rows filtered.
import { hub } from "../_hubs.js";
import { SITE, shell, withMeta } from "../_shared.js";

const hubHandler = hub("earnings");

const CAT = {
  men: {
    h1: "Men's padel prize money",
    name: "Men's earnings",
    title: "Men's padel prize money — career earnings leaderboard · PadelTicker",
    description:
      "Men's padel prize money by player: estimated career and per-season earnings across Premier Padel and the CUPRA FIP Tour, from published prize tables and draw placings.",
  },
  women: {
    h1: "Women's padel prize money",
    name: "Women's earnings",
    title: "Women's padel prize money — career earnings leaderboard · PadelTicker",
    description:
      "Women's padel prize money by player: estimated career and per-season earnings across Premier Padel and the CUPRA FIP Tour, from published prize tables and draw placings.",
  },
};

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const seg = url.pathname.split("/").filter(Boolean);
  const cat = CAT[String(seg[1] || "").toLowerCase()];
  // Anything that is not /earnings/men or /earnings/women — including a bare year —
  // is a view of the whole leaderboard, so it canonicalises to the hub.
  if (!cat) return hubHandler(ctx);

  const key = String(seg[1]).toLowerCase();
  const canonical = `${SITE}/earnings/${key}`;
  const base = await shell(url.origin);
  return withMeta(base, {
    h1: cat.h1,
    title: cat.title,
    description: cat.description,
    canonical,
    ogType: "website",
    jsonld: [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: cat.name,
        url: canonical,
        description: cat.description,
        isPartOf: { "@type": "WebSite", name: "PadelTicker", url: SITE + "/" },
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "PadelTicker", item: SITE + "/" },
          { "@type": "ListItem", position: 2, name: "Earnings", item: SITE + "/earnings" },
          { "@type": "ListItem", position: 3, name: cat.name, item: canonical },
        ],
      },
    ],
  });
}
