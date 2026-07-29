// WPT round-results — STEP 1: discover + fetch padel-magazine articles for each
// WPT tournament of a season, so a later step can extract the semis/quarters (with
// scores) from the prose. English Wikipedia gave us the finals + rankings; the
// deeper rounds only exist in news coverage. Discovery is keyed on the tournament's
// CITY within its date window (the reliable EN-name ↔ FR-name join), then filtered
// to round-report articles.
//
//   node scripts/wpt-rounds-fetch.mjs 2019   -> scratch/wpt-rounds-2019.raw.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YEAR = +(process.argv[2] || 2019);
const OUT = join(ROOT, "scratch", `wpt-rounds-${YEAR}.raw.json`);
const API = "https://padelmagazine.fr/wp-json/wp/v2/posts";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0 Safari/537.36";

const get = (u) => fetch(u, { headers: { "user-agent": UA } }).then((r) => (r.ok ? r.json() : []));
const strip = (h) => (h || "")
  .replace(/<[^>]+>/g, "\n").replace(/&#8217;|&#8216;/g, "'").replace(/&#8211;|&#8212;/g, "-")
  .replace(/&[a-z#0-9]+;/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
const shiftDay = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ROUND_RE = /demi|1\/2|1\/4|1\/8|quart|huitiem|finale?|master|open|challenger|tour|resultat/i;

const wpt = JSON.parse(readFileSync(join(ROOT, "public/data/archive/wpt.json"), "utf8"));
const tourns = wpt.tournaments.filter((t) => t.year === YEAR && t.start);

const out = [];
for (const t of tourns) {
  const city = (t.city || "").split("(")[0].trim();
  if (!city) { out.push({ ...pick(t), articles: [] }); continue; }
  // date window: a week before start .. ~two weeks after (covers the whole event + reports)
  const after = shiftDay(t.start, -8), before = shiftDay(t.start, 18);
  const url = `${API}?search=${encodeURIComponent(city)}&after=${after}T00:00:00&before=${before}T23:59:59&per_page=40&_fields=slug,date,title,content`;
  let posts = [];
  try { posts = await get(url); } catch { posts = []; }
  const cityLc = city.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const articles = (Array.isArray(posts) ? posts : [])
    .map((p) => ({ slug: p.slug, date: (p.date || "").slice(0, 10), title: strip(p.title?.rendered), text: strip(p.content?.rendered) }))
    // must plausibly be about THIS event: title or text mentions the city, and looks like a round report
    .filter((a) => {
      const hay = (a.title + " " + a.text.slice(0, 400)).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      return hay.includes(cityLc) && ROUND_RE.test(a.title + " " + a.text.slice(0, 200)) && /\d[\/-]\d/.test(a.text);
    });
  out.push({ ...pick(t), articles });
  console.log(`${t.start} ${city.padEnd(16)} ${String(articles.length).padStart(2)} article(s)  (${posts.length} candidates)`);
  await new Promise((r) => setTimeout(r, 350)); // polite
}

function pick(t) { return { key: t.key, name: t.name, city: t.city, start: t.start, haveFinals: Object.keys(t.finals) }; }

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ year: YEAR, tournaments: out }, null, 2));
const nArt = out.reduce((a, t) => a + t.articles.length, 0);
const nWith = out.filter((t) => t.articles.length).length;
console.log(`\n${nArt} round articles across ${nWith}/${tourns.length} tournaments -> ${OUT}`);
