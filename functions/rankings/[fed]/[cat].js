// GET /rankings/:fed/:cat — app shell with ranking-page meta injected.
import { SITE, shell, withMeta } from "../../_shared.js";

const REGION = {
  FIP: "FIP world", DK: "Denmark", SE: "Sweden", DE: "Germany", HR: "Croatia",
  EE: "Estonia", GE: "Georgia", HU: "Hungary", UA: "Ukraine", SI: "Slovenia",
  XK: "Kosovo", BA: "Bosnia & Herzegovina", ME: "Montenegro",
};

export async function onRequestGet({ request, params }) {
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

  // Pull the ranking rows to publish the top of the list as structured data.
  let rows = [];
  try {
    const file = fed === "FIP" ? "/data/rankings-fip.json" : "/data/rankings.json";
    const r = await fetch(origin + file + "?_=" + Date.now(), { cf: { cacheTtl: 0 } });
    if (r.ok) {
      const d = await r.json();
      const list = (d.lists || []).find(
        (l) => String(l.fed).toUpperCase() === fed && String(l.category).toLowerCase() === cat);
      rows = (list && list.rows) || [];
    }
  } catch {}

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

  return withMeta(base, { title, description, canonical, jsonld });
}
