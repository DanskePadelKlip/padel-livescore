// Shared helpers for server-rendered per-entity meta (SEO Phase 2).
//
// Social scrapers (Facebook, X/Twitter, iMessage, WhatsApp, Slack, Discord) and
// search crawlers' first pass do NOT run the SPA's JavaScript, so a shared link
// to /player/<id> or /tournament/<src>/<id> would otherwise show the generic
// homepage card. These route Functions fetch the entity, then inject an
// entity-specific <title>, description, canonical, Open Graph / Twitter tags and
// JSON-LD into the app shell before serving it. Real users get the exact same
// shell and the SPA boots and renders as normal.
//
// (Filenames starting with "_" are not turned into routes by Cloudflare Pages.)
export const SITE = "https://padelticker.com";

// The static app shell. index.html is a plain asset, so a same-origin fetch
// serves it directly — no Function recursion — and _headers keeps it no-cache,
// so we always rewrite the current shell (with the current app.js?v=<sha>).
export const shell = (origin) => fetch(origin + "/index.html", { cf: { cacheTtl: 0 } });

// Rewrite the shell's <head> with entity values. m: {title, description,
// canonical, ogType?, image?, jsonld?}.
export function withMeta(shellRes, m) {
  const content = (v) => ({ element(e) { if (v != null) e.setAttribute("content", String(v)); } });
  let rw = new HTMLRewriter()
    .on("title", { element(e) { e.setInnerContent(m.title); } })
    .on('meta[name="description"]', content(m.description))
    .on('link[rel="canonical"]', { element(e) { e.setAttribute("href", m.canonical); } })
    .on('meta[property="og:title"]', content(m.title))
    .on('meta[property="og:description"]', content(m.description))
    .on('meta[property="og:url"]', content(m.canonical))
    .on('meta[property="og:type"]', content(m.ogType || "website"))
    .on('meta[name="twitter:title"]', content(m.title))
    .on('meta[name="twitter:description"]', content(m.description));
  if (m.image) {
    rw = rw
      .on('meta[property="og:image"]', content(m.image))
      .on('meta[name="twitter:image"]', content(m.image));
  }
  // m.jsonld may be a single graph or an array of graphs (e.g. an entity plus a
  // BreadcrumbList / ItemList). Each is appended as its own <script>.
  const graphs = Array.isArray(m.jsonld) ? m.jsonld : (m.jsonld ? [m.jsonld] : []);
  for (const g of graphs) {
    // Escape "<" so a name containing markup can't break out of the script tag.
    const j = JSON.stringify(g).replace(/</g, "\\u003c");
    rw = rw.on("head", { element(e) { e.append(`<script type="application/ld+json">${j}</script>`, { html: true }); } });
  }
  const res = rw.transform(shellRes);
  const out = new Response(res.body, res);
  out.headers.set("content-type", "text/html; charset=utf-8");
  out.headers.set("cache-control", "no-cache"); // mirror the shell; entity data is cached at the API layer
  return out;
}

// Player meta needs only identity + the W-L record. Reading D1 directly here
// replaces the old fetch("/api/player/:id") from the page Function: that was a
// SECOND Function invocation per render, and it ran six queries - including a
// whole-history scan and a most-frequent-partner GROUP BY - to produce four
// numbers. The filter below (m.date IS NOT NULL) is the same one /api/player
// uses for its byYear aggregation, so the rendered figures are identical.
// Returns null when the id is unknown OR D1 is unavailable, which is exactly
// how the old code behaved when the API fetch failed: fall back to the shell.
export async function playerMeta(env, id) {
  try {
    const player = await env.DB
      .prepare("SELECT id,name,country FROM players WHERE id=?1").bind(id).first();
    if (!player) return null;
    const agg = await env.DB.prepare(
      `SELECT COUNT(*) total, SUM(CASE WHEN mp.is_winner=1 THEN 1 ELSE 0 END) wins
       FROM match_players mp JOIN matches m ON m.id=mp.match_id
       WHERE mp.player_id=?1 AND m.date IS NOT NULL`
    ).bind(id).first();
    const total = Number(agg?.total || 0);
    const wins = Number(agg?.wins || 0);
    return { player, summary: { total, wins, losses: total - wins } };
  } catch {
    return null;
  }
}
// One player's identity, falling back to the name/country carried on the match
// rows. FIP-only players ("fip-i-sager") appear in match_players long before
// they appear in `players`; without the fallback a pair page linked from a
// rivalry row would 404 purely because of that bookkeeping gap.
export async function identifyPlayer(env, id) {
  const p = await env.DB.prepare("SELECT id,name,country,is_nordic FROM players WHERE id=?1").bind(id).first();
  if (p) return p;
  const m = await env.DB
    .prepare("SELECT player_id id,name,country FROM match_players WHERE player_id=?1 AND name IS NOT NULL LIMIT 1")
    .bind(id).first();
  return m ? { ...m, is_nordic: 0, partial: 1 } : null;
}

// Pair meta needs only both identities and the record they have TOGETHER, so it
// reads D1 directly rather than calling /api/pair/:a/:b — that would be a second
// Function invocation per render, to produce four numbers out of a payload
// carrying every match and rivalry the pair has. The m.date IS NOT NULL filter
// matches playerMeta above, so the two pages' figures are derived alike.
// Returns null when either id is unknown or D1 is unavailable — the caller then
// serves the plain shell, exactly as the player route does.
export async function pairMeta(env, a, b) {
  try {
    const [pa, pb] = await Promise.all([identifyPlayer(env, a), identifyPlayer(env, b)]);
    if (!pa || !pb) return null;
    const agg = await env.DB.prepare(
      `SELECT COUNT(*) total, SUM(CASE WHEN p1.is_winner=1 THEN 1 ELSE 0 END) wins
       FROM match_players p1
       JOIN match_players p2 ON p2.match_id=p1.match_id AND p2.side=p1.side AND p2.player_id=?2
       JOIN matches m ON m.id=p1.match_id
       WHERE p1.player_id=?1 AND m.date IS NOT NULL`
    ).bind(a, b).first();
    const total = Number(agg?.total || 0);
    const wins = Number(agg?.wins || 0);
    return { a: pa, b: pb, summary: { total, wins, losses: total - wins } };
  } catch {
    return null;
  }
}
