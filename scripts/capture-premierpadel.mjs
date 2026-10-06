// Premier Padel capture: tournament list -> per-day match lists -> per-match stats.
// Raw JSON, exactly as served, so the join to padel.db/D1 can be redone without
// re-fetching. Premier Padel publishes per-match serve/return stats (aces, DFs,
// 1st/2nd serve and return points won, service games) for every match since 2024,
// and the match lists carry a live `server` field - see the stats endpoint below.
//
//   node scripts/capture-premierpadel.mjs                # incremental (default)
//   node scripts/capture-premierpadel.mjs --years=2024,2025,2026
//   node scripts/capture-premierpadel.mjs --limit=3      # first N tournaments only
//
// Incremental = re-list tournaments not yet captured or ending within the last
// 3 days; fetch stats only for finished matches with no stats file yet.
// Output (outside the repo, never deployed): PP_CAPTURE_DIR or ~/premierpadel-capture
//   tournaments-<year>.json
//   <slug>/day-<date>.json
//   <slug>/stats/<match_id>.json

import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api-prod.premierpadel.com/api/tournament";
const OUT = process.env.PP_CAPTURE_DIR || join(homedir(), "premierpadel-capture");
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const thisYear = new Date().getUTCFullYear();
const YEARS = (args.years || `${thisYear}`).split(",").map(Number);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const GAP_MS = 250; // be polite: ~4 req/s at most

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

async function post(path, body, form = false) {
  for (let attempt = 1; ; attempt++) {
    await sleep(GAP_MS);
    calls++;
    try {
      const res = await fetch(`${API}/${path}`, {
        method: "POST",
        headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" },
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 4) throw new Error(`${path} ${JSON.stringify(body)}: ${e.message}`);
      await sleep(2000 * attempt);
    }
  }
}

const save = (p, obj) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, JSON.stringify(obj)); };
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

let nT = 0, nDays = 0, nStats = 0, nNoStats = 0;
mkdirSync(OUT, { recursive: true });

for (const year of YEARS) {
  const tl = await post("getTournaments", { type: "all", year });
  const tours = Array.isArray(tl.data) ? tl.data : [];
  save(join(OUT, `tournaments-${year}.json`), tl);
  console.log(`${year}: ${tours.length} tournaments`);

  for (const t of tours) {
    if (nT >= LIMIT) break;
    const start = (t.start_date_utc || "").slice(0, 10);
    const end = (t.end_date_utc || "").slice(0, 10);
    if (!t.slug || !start || start > today) continue; // not started yet
    nT++;
    const dir = join(OUT, t.slug);
    const listed = existsSync(dir) && readdirSync(dir).some((f) => f.startsWith("day-"));
    const relist = !listed || end >= daysAgo(3);

    if (relist) {
      // The first call returns the list of play days; each day is its own call.
      const first = await post("getTournamentMatches", { slug: t.slug });
      for (const date of first.data?.date || []) {
        if (date > today) continue;
        const day = await post("getTournamentMatches", { slug: t.slug, date });
        save(join(dir, `day-${date}.json`), day);
        nDays++;
      }
    }

    // Stats for every finished match we do not have yet.
    const ids = new Set();
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      if (!f.startsWith("day-")) continue;
      const d = JSON.parse(readFileSync(join(dir, f), "utf8")).data;
      for (const c of d?.courts || []) for (const m of c.matches || []) if (m.status === "F") ids.add(m.match_id);
    }
    let got = 0;
    for (const id of ids) {
      const p = join(dir, "stats", `${id}.json`);
      if (existsSync(p)) continue;
      const s = await post("getTournamentMatchDetailsByType", { match_id: String(id), type: "Stats" }, true);
      const has = s.status && s.data?.match_state?.length;
      // An empty answer on a running event may just be "not entered yet": leave
      // it unsaved so the next run asks again. Older empties are final (byes, WOs).
      if (has || !relist) save(p, s);
      if (has) { nStats++; got++; } else nNoStats++;
    }
    console.log(`  ${t.slug} (${t.type}, ${start}): ${ids.size} finished, +${got} stats${relist ? "" : " [listing cached]"}`);
  }
}
console.log(`done: ${nT} tournaments, ${nDays} day lists, ${nStats} stats saved, ${nNoStats} empty, ${calls} calls -> ${OUT}`);
