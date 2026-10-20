// Server-rendered page BODIES (PadelTicker plan, Phase 1.1).
//
// withMeta() gave every entity page its own <head> and one hidden heading, but the
// body a crawler received was the same ~650 characters everywhere: the nav, the
// footer link hub and that heading. The ranking table, the player's matches and the
// tournament's results only existed after app.js ran, so to a first-pass crawler
// 26,000 URLs were near-identical thin pages (Search Console 2026-10-20: 377 indexed).
//
// These builders turn data the page already ships as STATIC files into plain
// markup for #app. Rules:
//   - Static assets only, read through env.ASSETS (assetText below). No D1, ever:
//     one crawl of the player sitemap at 7 queries a page spent the whole account's
//     daily D1 budget on 2026-09-04.
//   - CPU: the free plan allows 10 ms a request. A pm career shard is 1-1.5 MB and
//     takes 5-11 ms to JSON.parse, so pmPlayer() cuts out the one player's entry
//     and the names it needs instead of parsing the shard.
//   - The block goes INSIDE #app. app.js's first statement-level write is
//     `app.innerHTML = skeleton`, so the SPA replaces it on boot and never sees it;
//     the inline script hides it as soon as it is parsed, so a browser running JS
//     never paints it (no plain table flashing before the app's own). A crawler
//     reading the raw HTML gets all of it.
//
// (Filenames starting with "_" are not turned into routes by Cloudflare Pages.)

export const esc = (v) =>
  String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const HIDE = `<script>document.currentScript.parentNode.style.display="none"</script>`;
export const block = (inner) => (inner ? `<section class="ssr">${HIDE}${inner}</section>` : "");

// A static asset straight from this deployment. NOT fetch(origin + path):
// /data/rankings.json and /data/matches.json are Functions (functions/data/_serve.js)
// that read D1's live_blobs on a colo-cache miss, so a same-origin fetch is a second
// Function invocation against the 100k/day cap and can be a D1 read. A missing asset
// comes back as the 404 page (text/html), so only a JSON body counts.
export async function assetText(env, origin, path) {
  try {
    const r = await env.ASSETS.fetch(new Request(origin + path));
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return null;
    return await r.text();
  } catch {
    return null;
  }
}
export async function assetJson(env, origin, path) {
  const t = await assetText(env, origin, path);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

const playerHref = (id) => `/player/${encodeURIComponent(id)}`;
const fmtDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return "";
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${MO[Number(m[2]) - 1]} ${m[1]}`;
};

// ---------------------------------------------------------------- rankings

// list: one entry of rankings.json / rankings-fip.json `lists`. siblings: the other
// ranking pages, [[href, label], ...], so every ranking page links to the rest.
export function rankingBody({ list, fed, label, generatedAt, siblings = [], top = 100 }) {
  const all = (list && list.rows) || [];
  if (!all.length) return "";
  const rows = all.slice(0, top);
  const fip = fed === "FIP";
  // FIP's own feed prints "A. Coello"; `full` carries the real first name.
  const name = (r) => (fip && r.full) || r.name || "";
  const who = (r) => (r.id ? `<a href="${playerHref(r.id)}">${esc(name(r))}</a>` : esc(name(r)));
  // delta: rank places gained since the previous list (app.js mvCell semantics).
  const move = (r) =>
    r.delta === undefined ? "" : r.delta === null ? "new" : r.delta > 0 ? `up ${r.delta}` : r.delta < 0 ? `down ${-r.delta}` : "=";
  const third = fip ? "Country" : "Club";
  const total = Number(list.total) || all.length;
  const asOf = fmtDate(generatedAt);

  let h = `<h2>${esc(label)}: top ${rows.length}</h2>`;
  h += `<p>${total.toLocaleString("en-US")} ranked players${asOf ? `, list as of ${esc(asOf)}` : ""}. ` +
    `${fip ? "Points from the official FIP world ranking." : "Points as published by the national federation's ranking."}</p>`;
  h += `<table><thead><tr><th>Rank</th><th>Player</th><th>${third}</th><th>Points</th><th>Move</th></tr></thead><tbody>`;
  for (const r of rows) {
    h += `<tr><td>${esc(r.rank)}</td><td>${who(r)}</td><td>${esc(fip ? r.country : r.club)}</td>` +
      `<td>${esc(r.points)}</td><td>${esc(move(r))}</td></tr>`;
  }
  h += `</tbody></table>`;
  if (siblings.length)
    h += `<p>Other padel rankings: ${siblings.map(([href, t]) => `<a href="${esc(href)}">${esc(t)}</a>`).join(" · ")}</p>`;
  return block(h);
}

// ---------------------------------------------------------------- players

// djb2 over UTF-16 code units, mod shards: export_pt_matches.bucket() and app.js
// pmBucket() exactly. Keep the three identical.
export function pmBucket(id, n) {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 33) + id.charCodeAt(i)) >>> 0;
  return h % n;
}

// The end of the JSON value that starts at text[i] ("[" or "{"), honouring strings.
function valueEnd(text, i) {
  let depth = 0, inStr = false;
  for (let j = i; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (inStr) {
      if (c === 92) j++;            // backslash: skip the escaped char
      else if (c === 34) inStr = false;
    } else if (c === 34) inStr = true;
    else if (c === 91 || c === 123) depth++;
    else if (c === 93 || c === 125) { if (--depth === 0) return j + 1; }
  }
  return -1;
}

// One player's career groups out of a pm shard WITHOUT parsing the shard.
// Shard shape (padel-db export_pt_matches.py, written with separators=(",", ":")):
//   {"ev":{evkey:[name,date,tier,kind]}, "n":{id:name}, "p":{id:[[evkey,class,partner,[rows]]]}}
// Every value under ev and p is an array and every value under n a string, so a
// key followed by ':[' / ':"' can only be a key, and '"p":{' only the section.
// Returns { groups, ev, n, career }: the first `limit` matches with only their events
// and names, plus whole-career counts; null when the player has no entry or the shape
// is not the expected one.
export function pmPlayer(text, id, limit = 20) {
  const sec = (k) => text.indexOf(`"${k}":{`);
  const s = { ev: sec("ev"), n: sec("n"), p: sec("p") };
  if (s.ev < 0 || s.n < 0 || s.p < 0) return null;
  const bounds = (k) => {
    const start = s[k];
    const end = Math.min(...Object.values(s).filter((v) => v > start), text.length);
    return [start, end];
  };
  const lookup = (k, key, open) => {
    const [a, b] = bounds(k);
    const needle = JSON.stringify(key) + ":" + open;
    const at = text.indexOf(needle, a);
    if (at < 0 || at >= b) return undefined;
    const v0 = at + needle.length - 1;
    try {
      if (open === "[") { const e = valueEnd(text, v0); return e < 0 ? undefined : JSON.parse(text.slice(v0, e)); }
      // a string value: up to the first unescaped quote
      let j = v0 + 1;
      while (j < text.length && text.charCodeAt(j) !== 34) j += text.charCodeAt(j) === 92 ? 2 : 1;
      return JSON.parse(text.slice(v0, j + 1));
    } catch {
      return undefined;
    }
  };

  const all = lookup("p", id, "[");
  if (!Array.isArray(all) || !all.length) return null;
  let left = limit;
  const groups = [];
  for (const g of all) {
    if (left <= 0) break;
    const rows = (g[3] || []).slice(0, left);
    left -= rows.length;
    groups.push([g[0], g[1], g[2], rows]);
  }
  const ev = {}, n = {};
  const want = new Set();
  for (const g of groups) {
    if (!(g[0] in ev)) ev[g[0]] = lookup("ev", g[0], "[") || [g[0], "", null, "d"];
    if (g[2]) want.add(g[2]);
    for (const r of g[3]) for (const x of r.slice(4)) if (x) want.add(x);
  }
  for (const x of want) if (x[0] !== "=") n[x] = lookup("n", x, '"') || x;
  const career = { matches: all.reduce((a, g) => a + (g[3] || []).length, 0), events: new Set(all.map((g) => g[0])).size };
  return { groups, ev, n, career };
}

// The player's latest matches from the deployed career file, or null when there is
// none (no data/pm in this deployment, or no entry for the id).
export async function pmCareer(env, origin, id, limit = 20) {
  const meta = await assetJson(env, origin, "/data/pm/meta.json");
  if (!meta || !meta.shards) return null;
  const text = await assetText(env, origin, `/data/pm/${pmBucket(id, meta.shards)}.json`);
  return text ? pmPlayer(text, id, limit) : null;
}

// p: {id,name,country}; s: {total,wins,losses} from playerMeta (the same figures the
// SPA's header shows); pm: pmPlayer() output or null (no career file deployed: the
// GitHub Actions deploy of origin/main carries no data/pm, only the laptop's does).
export function playerBody({ p, s, pm }) {
  let h = `<h2>${esc(p.name)}: padel record</h2>`;
  const cc = p.country ? String(p.country).toUpperCase() : "";
  if (s && s.total) {
    const pct = Math.round((s.wins / s.total) * 100);
    h += `<p>${esc(s.total)} matches, ${esc(s.wins)} won and ${esc(s.losses)} lost (${pct}% win rate)${cc ? `. Country: ${esc(cc)}` : ""}.</p>`;
  } else if (cc) h += `<p>Country: ${esc(cc)}.</p>`;
  if (pm && pm.groups.length) {
    const { ev, n, career } = pm;
    const who = (x) => !x ? "" : x[0] === "=" ? esc(x.slice(1)) : `<a href="${playerHref(x)}">${esc(n[x] || x)}</a>`;
    const shown = pm.groups.reduce((a, g) => a + g[3].length, 0);
    h += `<h3>Latest ${shown} matches</h3>`;
    if (career.matches > shown)
      h += `<p>Full career list: ${career.matches} matches in ${career.events} tournaments.</p>`;
    for (const [key, cls, partner, rows] of pm.groups) {
      const e = ev[key] || [key, "", null, "d"];
      const tag = e[3] === "n" ? "National team" : e[2] || "";   // kind n = national-team event
      const head = [esc(e[0]), tag && esc(tag), cls && esc(cls), fmtDate(e[1])].filter(Boolean).join(" · ");
      h += `<h4>${head}${partner ? ` · with ${who(partner)}` : ""}</h4><ul>`;
      for (const r of rows) {
        const [date, round, score, won, o1, o2, rp] = r;
        const opp = [o1, o2].filter(Boolean).map(who).join(" / ") || "unknown";
        h += `<li>${round ? esc(round) + ": " : ""}${won ? "won" : "lost"} ${esc(score || "")} ` +
          `${rp ? `with ${who(rp)} ` : ""}against ${opp}${date ? `, ${esc(fmtDate(date))}` : ""}</li>`;
      }
      h += `</ul>`;
    }
  }
  return block(h);
}

// ---------------------------------------------------------------- tournaments

// Round order and category split: app.js roundRank() / splitCategory() /
// byClassTier(), so the server list reads in the same order as the draw page.
function roundRank(r) {
  const s = (r || "").toLowerCase();
  if (/plats|platz|place|3rd|5th/.test(s)) return 85;
  if (/semi/.test(s)) return 90;
  if (/quarter|kvart/.test(s)) return 80;
  if (/\bfinals?\b|\bfinale\b/.test(s)) return 100;
  if (/round of 16|1\/8|\br16\b|åttendel|ottendel/.test(s)) return 70;
  if (/round of 32|1\/16|\br32\b/.test(s)) return 60;
  if (/round of 64|1\/32|\br64\b/.test(s)) return 50;
  if (/round 1|runde 1|round one/.test(s)) return 40;
  if (/group|gruppe|grupp|round ?robin|monrad|pool/.test(s)) return 20;
  if (/q\d|quali|kval/.test(s)) return 15;
  return 30;
}
function splitCategory(m) {
  let cls = m.className || "";
  let round = m.round || "";
  if (!cls) {
    const g = round.match(/^(Men|Women|Herren|Damen|Herrer?|Damer?|Mixed)\s+/i);
    if (g) { cls = g[1]; round = round.slice(g[0].length).trim(); }
  }
  return { cls, round };
}
const pointsTier = (n) => 30 + Math.min(60, n / 25);
function classTier(cls) {
  const s = String(cls || "").toLowerCase();
  if (/elitedivision/.test(s)) return 65;
  if (/\b1\.\s*division\b/.test(s)) return 45;
  if (/\bdm\b|danmarksmesterskab/.test(s)) return 95;
  if (/nordic championship/.test(s)) return 90;
  const dpf = [...s.matchAll(/\bdpf\s*-?\s*(\d{2,4})\b/g)].map((x) => +x[1]);
  if (dpf.length) return pointsTier(Math.max(...dpf));
  if (/\bspt\b/.test(s)) { const p = s.match(/\b(\d{3})\b/); return p ? pointsTier(+p[1]) : 55; }
  return 0;
}
const byClassTier = (a, b) => {
  const ta = classTier(a[0]), tb = classTier(b[0]);
  if (ta !== tb) return tb - ta;
  return ta > 0 ? String(a[0]).localeCompare(String(b[0]), "da") : 0;
};
// FIP writes a tie-break set as games + tie-break points ("76" = 7-6, tb 6): app.js setParts.
const setText = (v) => { const m = /^([67])(\d+)$/.exec(String(v == null ? "" : v)); return m ? `${m[1]}(${m[2]})` : String(v == null ? "" : v); };

const MAX_MATCHES = 600; // the biggest archived draw has 462

// matches: an archive file's `matches`, or the live feed's rows for this event.
export function tournamentBody({ name, matches }) {
  const ms = (matches || []).slice(0, MAX_MATCHES);
  if (!ms.length) return "";
  const team = (t) => esc((t && (t.name || (t.players || []).map((p) => p.name).join(" / "))) || "TBD");
  const line = (m) => {
    const sets = (m.score && m.score.sets) || [];
    const w = m.score ? m.score.winner : null;
    const score = sets.map((s) => `${setText(s[0])}-${setText(s[1])}`).join(" ");
    const [a, b] = [team(m.teams[0]), team(m.teams[1])];
    let txt;
    if (m.status === "final" && (w === 0 || w === 1)) {
      // print the score from the winner's side, the way results are read aloud
      const ws = sets.map((s) => `${setText(s[w])}-${setText(s[1 - w])}`).join(" ");
      txt = `${w === 0 ? a : b} beat ${w === 0 ? b : a}${ws ? " " + esc(ws) : ""}`;
    } else if (m.status === "live") txt = `${a} vs ${b}${score ? ", " + esc(score) : ""} (live)`;
    else txt = `${a} vs ${b}${m.status === "final" && score ? " " + esc(score) : ""}`;
    return `<li>${txt}</li>`;
  };

  const cats = new Map();
  for (const m of ms) {
    if (!m || !Array.isArray(m.teams) || m.teams.length < 2) continue;
    const { cls, round } = splitCategory(m);
    if (!cats.has(cls)) cats.set(cls, new Map());
    const rmap = cats.get(cls);
    if (!rmap.has(round)) rmap.set(round, []);
    rmap.get(round).push(m);
  }
  const n = [...cats.values()].reduce((a, r) => a + [...r.values()].reduce((x, l) => x + l.length, 0), 0);
  if (!n) return "";
  const finals = ms.filter((m) => m.status === "final").length;
  let h = `<h2>${esc(name)}: results by round</h2>`;
  h += `<p>${n} matches${finals !== n ? `, ${finals} finished` : ""}${cats.size > 1 ? ` in ${cats.size} categories` : ""}.</p>`;
  for (const [cls, rmap] of [...cats.entries()].sort(byClassTier)) {
    if (cls) h += `<h3>${esc(cls)}</h3>`;
    const rh = cls ? "h4" : "h3"; // no category heading: rounds sit one level up
    for (const [round, list] of [...rmap.entries()].sort((a, b) => roundRank(b[0]) - roundRank(a[0]))) {
      h += `<${rh}>${esc(round || "Matches")}</${rh}><ul>${list.map(line).join("")}</ul>`;
    }
  }
  if ((matches || []).length > ms.length) h += `<p>First ${ms.length} of ${matches.length} matches shown.</p>`;
  return block(h);
}

// ---------------------------------------------------------------- national teams

const ORD = (n) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);
const natHref = (c) => `/national-teams/country/${encodeURIComponent(String(c).toLowerCase())}`;
// archive key "fip-135412" -> /tournament/fip/135412 (sitemap.xml.js does the same split)
const tkeyHref = (k) => {
  const i = String(k || "").indexOf("-");
  return i > 0 ? `/tournament/${encodeURIComponent(k.slice(0, i))}/${encodeURIComponent(k.slice(i + 1))}` : null;
};
const evSort = (a, b) => b.year - a.year || String(a.comp).localeCompare(String(b.comp));
const evTitle = (e) => {
  const t = `${esc(e.comp)} ${esc(e.year)}`;
  const href = e.tkey && tkeyHref(e.tkey);
  return href ? `<a href="${href}">${t}</a>` : t;
};
const evSub = (e) => [e.body && esc(e.body), e.cat && esc(e.cat), e.where && esc(e.where), e.start && esc(fmtDate(e.start))].filter(Boolean).join(" · ");
const G = { men: "Men", women: "Women" };

// national-teams.json. assetJson trusts a JSON body only, so a missing asset (served
// as the 404 page) reads as null.
export const natTeams = (env, origin) => assetJson(env, origin, "/data/national-teams.json");
// hub() body builder for /national-teams and its filter slices.
export const natTeamsHubBody = async ({ request, env }) =>
  natTeamsBody(await natTeams(env, new URL(request.url).origin));

// d: national-teams.json. Every championship, both genders, every placed nation.
export function natTeamsBody(d) {
  const evs = ((d && d.events) || []).slice().sort(evSort);
  const rows = (d && d.rows) || [];
  if (!evs.length || !rows.length) return "";
  const countries = d.countries || {};
  let h = `<h2>National team padel championships: final placings</h2>`;
  if (d.note) h += `<p>${esc(d.note)}</p>`;
  for (const e of evs) {
    h += `<h3>${evTitle(e)}</h3><p>${evSub(e)}</p>`;
    for (const g of e.genders || []) {
      const rs = rows.filter((r) => r.ev === e.id && r.g === g).sort((a, b) => a.pos - b.pos);
      if (!rs.length) continue;
      h += `<h4>${G[g] || esc(g)}</h4><table><thead><tr><th>Place</th><th>Nation</th><th>How</th></tr></thead><tbody>` +
        rs.map((r) => `<tr><td>${esc(r.pos)}</td><td><a href="${natHref(r.c)}">${esc(r.name)}</a></td><td>${esc(r.via)}</td></tr>`).join("") +
        `</tbody></table>`;
      const un = ((e.unplaced || {})[g]) || [];
      if (un.length)
        h += `<p>Also entered, no placing stated by the draw: ${un.map((c) => `<a href="${natHref(c)}">${esc((countries[c] || {}).name || c)}</a>`).join(", ")}</p>`;
    }
  }
  const gaps = d.gaps || [];
  if (gaps.length)
    h += `<h3>Not sourced yet</h3><ul>${gaps.map((g) => `<li>${esc(g.comp)} ${esc(g.year)}${g.where ? ` (${esc(g.where)})` : ""}: ${esc(g.why)}</li>`).join("")}</ul>`;
  return block(h);
}

// One nation's placings across every championship (the country page).
export function natCountryBody(d, code) {
  const meta = ((d && d.countries) || {})[code] || {};
  const evById = new Map(((d && d.events) || []).map((e) => [e.id, e]));
  const rows = ((d && d.rows) || []).filter((r) => r.c === code)
    .sort((a, b) => evSort(evById.get(a.ev) || {}, evById.get(b.ev) || {}) || a.g.localeCompare(b.g));
  if (!rows.length) return "";
  const name = meta.name || code;
  const medals = [[1, "gold"], [2, "silver"], [3, "bronze"]]
    .map(([p, m]) => [rows.filter((r) => r.pos === p).length, m]).filter(([k]) => k);
  const best = Math.min(...rows.map((r) => r.pos));
  let h = `<h2>${esc(name)}: national team championship placings</h2>`;
  h += `<p>${rows.length} sourced placing${rows.length === 1 ? "" : "s"}, best ${ORD(best)}` +
    `${medals.length ? ` (${medals.map(([k, m]) => `${k} ${m}`).join(", ")})` : ""}.</p>`;
  h += `<table><thead><tr><th>Championship</th><th>Category</th><th>Place</th><th>How</th></tr></thead><tbody>`;
  for (const r of rows) {
    const e = evById.get(r.ev) || { comp: r.ev, year: "" };
    h += `<tr><td>${evTitle(e)}</td><td>${esc([e.cat, G[r.g] || r.g].filter(Boolean).join(" "))}</td>` +
      `<td>${esc(ORD(r.pos))}</td><td>${esc(r.via)}</td></tr>`;
  }
  h += `</tbody></table><p><a href="/national-teams">All national team championships</a></p>`;
  return block(h);
}
