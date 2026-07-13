// CLI: run the aggregate pipeline and write public/data/matches.json.
// This stands in for the future scheduled edge worker.
//
//   node scripts/fetch-live.js            # today
//   node scripts/fetch-live.js 2026-07-12 # a specific day

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate } from "../src/aggregate.js";
import { fetchRankings } from "../src/rankings.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const date = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Date().toISOString().slice(0, 10);

console.log(`\n⚡ Fetching padel matches for ${date}\n`);
const matches = await aggregate({ date, log: (m) => console.log(m) });

const tally = (key) =>
  matches.reduce((acc, m) => ((acc[m[key]] = (acc[m[key]] || 0) + 1), acc), {});

console.log(`\n📊 ${matches.length} matches total`);
console.log("   by status:", tally("status"));
console.log("   by federation:", tally("federation"));

const outDir = join(root, "public", "data");
mkdirSync(outDir, { recursive: true });
const payload = { generatedAt: new Date().toISOString(), date, count: matches.length, matches };
writeFileSync(join(outDir, "matches.json"), JSON.stringify(payload, null, 2));
console.log(`\n✅ Wrote public/data/matches.json`);

// national rankings (RankedIn) — regenerated each run, deployed with the site
console.log(`\n🏆 Fetching national rankings`);
const lists = await fetchRankings({ log: (m) => console.log(m) });
if (lists.length) {
  writeFileSync(join(outDir, "rankings.json"), JSON.stringify({ generatedAt: new Date().toISOString(), lists }, null, 2));
  console.log(`✅ Wrote public/data/rankings.json (${lists.length} lists)\n`);
}
