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
  if (m.jsonld) {
    // Escape "<" so a name containing markup can't break out of the script tag.
    const j = JSON.stringify(m.jsonld).replace(/</g, "\\u003c");
    rw = rw.on("head", { element(e) { e.append(`<script type="application/ld+json">${j}</script>`, { html: true }); } });
  }
  const res = rw.transform(shellRes);
  const out = new Response(res.body, res);
  out.headers.set("content-type", "text/html; charset=utf-8");
  out.headers.set("cache-control", "no-cache"); // mirror the shell; entity data is cached at the API layer
  return out;
}
