// GET /sitemap.xml — self-refreshing sitemap built from the live data files, so
// search engines discover the deep-linkable routes (rankings, tournaments,
// players) added in the SEO routing work. Everything is derived at request time
// from public/data/*.json and cached at the edge for an hour.
const BASE = "https://padelticker.com";

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const seg = (s) => encodeURIComponent(String(s));

async function grab(origin, path) {
  try {
    const r = await fetch(origin + path + "?_=" + Date.now(), { cf: { cacheTtl: 0 } });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

export async function onRequestGet({ request }) {
  const origin = new URL(request.url).origin;
  const today = new Date().toISOString().slice(0, 10);

  const [matches, archive, natRanks, fipRanks] = await Promise.all([
    grab(origin, "/data/matches.json"),
    grab(origin, "/data/archive/index.json"),
    grab(origin, "/data/rankings.json"),
    grab(origin, "/data/rankings-fip.json"),
  ]);

  const urls = [];
  const add = (loc, { lastmod, changefreq, priority } = {}) =>
    urls.push({ loc: BASE + loc, lastmod, changefreq, priority });

  // 1) Core pages.
  add("/", { changefreq: "hourly", priority: "1.0", lastmod: today });
  add("/events", { changefreq: "hourly", priority: "0.8", lastmod: today });
  add("/rankings", { changefreq: "daily", priority: "0.8", lastmod: today });
  add("/results", { changefreq: "daily", priority: "0.7", lastmod: today });
  add("/players", { changefreq: "weekly", priority: "0.6" });

  // 2) One page per ranking list (fed + category).
  const lists = [...((fipRanks && fipRanks.lists) || []), ...((natRanks && natRanks.lists) || [])];
  for (const l of lists) {
    if (!l.fed || !l.category) continue;
    add(`/rankings/${seg(l.fed)}/${seg(l.category)}`, { changefreq: "daily", priority: "0.7", lastmod: today });
  }

  // 3) Live tournaments (source:id → /tournament/source/id).
  const liveSeen = new Set();
  for (const m of (matches && matches.matches) || []) {
    const key = m.source + ":" + m.tournament.id;
    if (liveSeen.has(key)) continue;
    liveSeen.add(key);
    add(`/tournament/${seg(m.source)}/${seg(m.tournament.id)}`, { changefreq: "hourly", priority: "0.8", lastmod: today });
  }

  // 4) Archive tournaments (key "source-id"; strip the source prefix for the id).
  for (const t of (archive && archive.tournaments) || []) {
    if (!t.key || !t.source) continue;
    const id = t.key.startsWith(t.source + "-") ? t.key.slice(t.source.length + 1) : t.key;
    add(`/tournament/${seg(t.source)}/${seg(id)}`, { changefreq: "monthly", priority: "0.5", lastmod: t.end || t.start });
  }

  // 5) Player profiles — every ranked player with a RankedIn id, deduped.
  const players = new Set();
  for (const l of lists) for (const r of l.rows || []) if (r.id) players.add(r.id);
  for (const id of players) add(`/player/${seg(id)}`, { changefreq: "weekly", priority: "0.5" });

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map((u) => {
        let s = `  <url><loc>${xmlEscape(u.loc)}</loc>`;
        if (u.lastmod) s += `<lastmod>${xmlEscape(u.lastmod)}</lastmod>`;
        if (u.changefreq) s += `<changefreq>${u.changefreq}</changefreq>`;
        if (u.priority) s += `<priority>${u.priority}</priority>`;
        return s + `</url>`;
      })
      .join("\n") +
    `\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
