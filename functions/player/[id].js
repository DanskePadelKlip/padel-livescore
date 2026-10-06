// GET /player/:id — app shell with this player's meta injected for scrapers.
import { SITE, shell, withMeta, playerMeta, decodeParam } from "../_shared.js";

export async function onRequestGet({ request, params, env }) {
  const origin = new URL(request.url).origin;
  const id = decodeParam(params.id);
  const base = await shell(origin);
  // One direct D1 read; no second Function invocation. See playerMeta in _shared.js.
  const d = await playerMeta(env, id);
  if (!d) {
    // A name-derived profile that has since been linked to its RankedIn one
    // (padel-db fip_link.py) is deleted from D1, so its old URL would land on
    // "not found" while the player is right there under another id - one human,
    // two pages, then one page and a dead link. Send it on, permanently.
    const to = id.startsWith("fip-") ? await relinkedTo(env, origin, id) : null;
    if (to && to !== id) return Response.redirect(`${origin}/player/${encodeURIComponent(to)}`, 301);
    return base; // unknown id, or D1 down -> generic shell (SPA still works)
  }

  const p = d.player;
  const s = d.summary || {};
  const cc = p.country ? String(p.country).toUpperCase() : "";
  const wl = s.total ? `${s.wins}–${s.losses}` : null;         // en-dash
  const pct = s.total ? Math.round((s.wins / s.total) * 100) : null;

  const bits = [];
  if (cc) bits.push(cc);
  if (s.total) bits.push(`${s.total} matches`);
  if (wl) bits.push(`${wl} W–L`);
  if (pct != null) bits.push(`${pct}% win rate`);

  const title = `${p.name} — padel results, ranking & head-to-head · PadelTicker`;
  const description =
    `${p.name}${bits.length ? " — " + bits.join(" · ") : ""}. ` +
    `Full padel match history, results and head-to-head on PadelTicker.`;
  const canonical = `${SITE}/player/${encodeURIComponent(id)}`;

  const jsonld = [
    {
      "@context": "https://schema.org",
      "@type": "Person",
      name: p.name,
      url: canonical,
      jobTitle: "Padel player",
      knowsAbout: "Padel",
      ...(cc ? { nationality: cc } : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "PadelTicker", item: SITE + "/" },
        { "@type": "ListItem", position: 2, name: "Players", item: SITE + "/players" },
        { "@type": "ListItem", position: 3, name: p.name, item: canonical },
      ],
    },
  ];

  const image = `${SITE}/og/player/${encodeURIComponent(id)}`;
  // bits is already the page's facts (country, matches, W-L, win rate); reused as the
  // hidden lead so the heading is not the only thing a first-pass crawler can read.
  return withMeta(base, {
    h1: p.name,
    lead: bits.join(" · "),
    title, description, canonical, ogType: "profile", image, jsonld,
  });
}

// The id a printed FIP name now resolves to, from players-lite.json's `aliases`
// (printed name -> profile id, written by padel-db export_d1.py). Read only on
// this miss path, so the 2 MB file costs nothing on a normal profile view.
// The slug rule is export_d1.name_id(): keep the three copies identical.
async function relinkedTo(env, origin, id) {
  try {
    const r = await env.ASSETS.fetch(new Request(origin + "/data/players-lite.json"));
    if (!r.ok) return null;
    const { aliases } = await r.json();
    for (const [name, pid] of Object.entries(aliases || {})) {
      const slug = ("fip-" + name.replaceAll(". ", "-").replace(/ /g, "-").replace(/\./g, ""))
        .replace(/[A-Z]/g, (c) => c.toLowerCase());
      if (slug === id) return pid;
    }
  } catch { /* no index: fall through to the shell */ }
  return null;
}
