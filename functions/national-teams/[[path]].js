// GET /national-teams/<gender>/<category> - the section's filter slices.
// GET /national-teams/country/<ioc>        - one nation's own page.
//
// Without this they fell through to the app shell, whose canonical is the homepage:
// Google would be told "index this" and "this is really the homepage" at once, which
// is what dropped the hub pages in 2026-07 (see _hubs.js). hub() canonicalises every
// slice back to /national-teams, which is the honest answer - they are the same rows
// filtered, not separate pages - so only /national-teams is in the sitemap.
//
// A country page is NOT a slice: it is one nation's record across every championship,
// with its own heading and its own answer, so it gets a self-canonical, its own title
// and its own sitemap entry (see sitemap.xml.js). An unknown or unplaced code falls
// back to the hub rather than minting a self-canonical for a URL with nothing on it.
import { hub } from "../_hubs.js";
import { SITE, shell, withMeta } from "../_shared.js";

const hubHandler = hub("national-teams");
const ORD = (n) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);

async function natTeams(origin) {
  try {
    // A missing asset is served the app shell at 200 (see _shared.js / Pages ASSETS
    // fallback), so the parse - not the status - is what decides whether we got data.
    const r = await fetch(origin + "/data/national-teams.json", { cf: { cacheTtl: 300 } });
    return await r.json();
  } catch { return null; }
}

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[1] !== "country" || !seg[2]) return hubHandler(ctx);

  const code = decodeURIComponent(seg[2]).toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(code)) return hubHandler(ctx);

  const d = await natTeams(url.origin);
  const meta = d && d.countries ? d.countries[code] : null;
  const rows = ((d && d.rows) || []).filter((r) => r.c === code);
  if (!meta || !rows.length) return hubHandler(ctx);

  const evById = new Map(((d && d.events) || []).map((e) => [e.id, e]));
  const best = rows.reduce((a, r) => (a && a.pos <= r.pos ? a : r), null);
  const bestEv = evById.get(best.ev) || {};
  const name = meta.name || code;
  const title = `${name} national padel team — championship placings · PadelTicker`;
  const description =
    `${name} at the national team padel championships: ${rows.length} sourced placing${rows.length === 1 ? "" : "s"}, ` +
    `best ${ORD(best.pos)} at the ${bestEv.comp || "championship"} ${bestEv.year || ""}`.trim() +
    `. Every placing is read off the tournament's own placement bracket, never inferred.`;
  const canonical = `${SITE}/national-teams/country/${code.toLowerCase()}`;

  const base = await shell(url.origin);
  return withMeta(base, {
    title,
    description,
    canonical,
    ogType: "website",
    jsonld: [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: `${name} — national team padel championships`,
        url: canonical,
        description,
        isPartOf: { "@type": "WebSite", name: "PadelTicker", url: SITE + "/" },
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "PadelTicker", item: SITE + "/" },
          { "@type": "ListItem", position: 2, name: "National teams", item: SITE + "/national-teams" },
          { "@type": "ListItem", position: 3, name, item: canonical },
        ],
      },
    ],
  });
}
