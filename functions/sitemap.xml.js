// GET /sitemap.xml — self-refreshing sitemap built from the live data files, so
// search engines discover the deep-linkable routes (rankings, tournaments,
// players) added in the SEO routing work. Everything is derived at request time
// from public/data/*.json and cached at the edge for an hour.
//
// Not listed on purpose: pair pages (see the note above the player block) and player
// ids D1 holds no profile for.
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

// Ids D1 holds a profile for, from players-lite.json (padel-db export_d1.py writes it
// after the nightly D1 load, so it lists exactly the ids /player/<id> can render).
// Read through env.ASSETS - it is a static file, so this costs no Function invocation
// - and scanned rather than JSON.parse'd: only the ids are needed, and parsing the
// 2.6 MB file costs ~27 ms of CPU against ~20 ms for the scan. Null when the file
// cannot be read; the caller then lists every id, as before, rather than dropping
// the whole player block over one read miss.
async function profileIds(env, origin) {
  try {
    const r = await env.ASSETS.fetch(new Request(origin + "/data/players-lite.json"));
    if (!r.ok) return null;
    const s = await r.text();
    const from = s.indexOf('"players"');
    if (from < 0) return null;
    const to = s.indexOf('"aliases"', from);
    const ids = new Set();
    const re = /\["((?:[^"\\]|\\.)*)",/g; // ["<id>", ... - the first field of each row
    re.lastIndex = from;
    for (let m; (m = re.exec(s)) && (to < 0 || m.index < to); ) {
      ids.add(m[1].includes("\\") ? JSON.parse(`"${m[1]}"`) : m[1]);
    }
    return ids.size ? ids : null;
  } catch {
    return null;
  }
}

export async function onRequestGet({ request, env }) {
  const origin = new URL(request.url).origin;
  const today = new Date().toISOString().slice(0, 10);

  const [matches, archive, natRanks, fipRanks, natTeams, eloRanks] = await Promise.all([
    grab(origin, "/data/matches.json"),
    grab(origin, "/data/archive/index.json"),
    grab(origin, "/data/rankings.json"),
    grab(origin, "/data/rankings-fip.json"),
    grab(origin, "/data/national-teams.json"),
    grab(origin, "/data/rankings-elo.json"),
  ]);

  const urls = [];
  const add = (loc, { lastmod, changefreq, priority } = {}) =>
    urls.push({ loc: BASE + loc, lastmod, changefreq, priority });

  // 1) Core pages.
  add("/", { changefreq: "hourly", priority: "1.0", lastmod: today });
  add("/events", { changefreq: "hourly", priority: "0.8", lastmod: today });
  add("/map", { changefreq: "hourly", priority: "0.6", lastmod: today });
  add("/rankings", { changefreq: "daily", priority: "0.8", lastmod: today });
  add("/results", { changefreq: "daily", priority: "0.7", lastmod: today });
  add("/players", { changefreq: "weekly", priority: "0.6" });
  // National teams: the hub only. /national-teams/<gender>/<category> is
  // deep-linkable, but every slice canonicalises to the hub, and a sitemap URL that
  // points its canonical somewhere else is exactly what cost this site its hub pages
  // in 2026-07 (see _hubs.js).
  add("/national-teams", { changefreq: "monthly", priority: "0.6" });
  // One page per nation IS listed: unlike the gender/category slices, a country page is
  // its own content (that nation's record across every championship) and carries its own
  // canonical, so it is a page a crawler should hold rather than a filtered view.
  for (const code of new Set(((natTeams && natTeams.rows) || []).map((r) => r.c).filter(Boolean))) {
    add(`/national-teams/country/${seg(String(code).toLowerCase())}`, { changefreq: "monthly", priority: "0.5" });
  }
  add("/pairs", { changefreq: "weekly", priority: "0.6" });
  // Earnings: the hub plus one page per gender. The per-year URLs are deep-linkable
  // too, but they are slices of the same rows — listing them would pad the sitemap
  // with near-duplicates for no crawl benefit.
  add("/earnings", { changefreq: "weekly", priority: "0.7", lastmod: today });
  add("/earnings/men", { changefreq: "weekly", priority: "0.6", lastmod: today });
  add("/earnings/women", { changefreq: "weekly", priority: "0.6", lastmod: today });
  add("/rules", { changefreq: "monthly", priority: "0.5" });
  add("/dictionary", { changefreq: "monthly", priority: "0.5" });

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

  // 5) Player profiles — every ranked player with a RankedIn id, deduped, but only
  // where D1 holds a profile. On 2026-10-21, 1,965 of the 6,155 player URLs listed
  // here were national-ranking rows with no D1 profile: /player/<id> served them the
  // bare shell (home title, canonical "/") and the SPA showed the players directory,
  // so each one was a sitemap URL that was not the page it named.
  const known = await profileIds(env, origin);
  const players = new Set();
  for (const l of lists) for (const r of l.rows || []) if (r.id) players.add(r.id);
  // The Elo board too: every row carries a real id, including the FIP tour (fip-<slug>),
  // whose points list mostly has none - without this the pro tour had no player URL at all.
  for (const l of (eloRanks && eloRanks.lists) || []) for (const r of l.rows || []) if (r.id) players.add(r.id);
  for (const id of players) {
    if (known && !known.has(id)) continue;
    add(`/player/${seg(id)}`, { changefreq: "weekly", priority: "0.5" });
  }

  // Pair pages (/pair/<a>/<b>) are deliberately NOT listed (Kim, 2026-10-21). They
  // were 18,052 of the 25,769 URLs here, they arrived the week Google clicks fell
  // (bd1606c, 2026-08-28), and a pair page is a thin slice of two player pages.
  // They stay reachable from the app and from the /pairs hub, which is listed
  // above. Dropping the block also drops its /api/pairs call: a second Function
  // invocation and a 4.8 MB JSON parse on every sitemap request.

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
