// GET /rankings/:fed/:cat — app shell with ranking-page meta injected.
import { SITE, shell, withMeta } from "../../_shared.js";
import { assetJson, rankingBody } from "../../_ssr.js";

const REGION = {
  FIP: "FIP world", DK: "Denmark", SE: "Sweden", DE: "Germany", HR: "Croatia",
  EE: "Estonia", GE: "Georgia", HU: "Hungary", UA: "Ukraine", SI: "Slovenia",
  XK: "Kosovo", BA: "Bosnia & Herzegovina", ME: "Montenegro",
};

export async function onRequestGet({ request, params, env }) {
  const origin = new URL(request.url).origin;
  const fed = String(params.fed || "").toUpperCase();
  const cat = String(params.cat || "").toLowerCase();
  const base = await shell(origin);

  const region = REGION[fed];
  if (!region || (cat !== "men" && cat !== "women")) return base; // unknown → generic

  const g = cat === "women" ? "women's" : "men's";
  const title = `${region} ${g} padel ranking · PadelTicker`;
  const description =
    `The ${region} ${g} padel ranking — live points, positions and weekly movement, updated continuously on PadelTicker.`;
  const canonical = `${SITE}/rankings/${fed}/${cat}`;

  // Pull the ranking rows: the top of the list as structured data, and the top 100
  // as the page body. Straight from the deployed asset - fetch(origin + file) went
  // through the /data/rankings.json Function, a second invocation and a D1 read on
  // every colo-cache miss (see assetText in _ssr.js).
  const file = fed === "FIP" ? "/data/rankings-fip.json" : "/data/rankings.json";
  const d = await assetJson(env, origin, file);
  const list = ((d && d.lists) || []).find(
    (l) => String(l.fed).toUpperCase() === fed && String(l.category).toLowerCase() === cat);
  const rows = (list && list.rows) || [];

  const jsonld = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "PadelTicker", item: SITE + "/" },
        { "@type": "ListItem", position: 2, name: "Rankings", item: SITE + "/rankings" },
        { "@type": "ListItem", position: 3, name: `${region} ${cat}`, item: canonical },
      ],
    },
  ];
  if (rows.length) {
    jsonld.push({
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: `${region} ${g} padel ranking`,
      numberOfItems: rows.length,
      itemListElement: rows.slice(0, 25).map((row) => ({
        "@type": "ListItem",
        position: row.rank,
        name: row.name,
        ...(row.id ? { url: `${SITE}/player/${encodeURIComponent(row.id)}` } : {}),
      })),
    });
  }

  // Every other ranking page, so each list links to the rest (the crawl path between
  // them no longer depends on app.js drawing the federation chips).
  const siblings = [];
  for (const [f, r] of Object.entries(REGION))
    for (const c of ["men", "women"])
      if (f !== fed || c !== cat) siblings.push([`/rankings/${f}/${c}`, `${r} ${c}`]);
  const body = rankingBody({ list, fed, label: `${region} ${g} padel ranking`, generatedAt: d && d.generatedAt, siblings });

  return withMeta(base, {
    h1: `${region} ${g} padel ranking`,
    lead: rows.length ? `${rows.length} ranked players` : "",
    title, description, canonical, jsonld, body,
  });
}
