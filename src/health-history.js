// Carry per-source last-success timestamps across health snapshots so /api/health
// can tell a TRANSIENT scrape blip (recently ok -> warn) from a PERSISTENT outage
// (a source dark for hours -> down; e.g. a browser source dying on a Playwright
// bump, which otherwise sat at "warn" forever while RankedIn masked the loss).
//
// BOTH producers of public/data/health.json must run sources through this, or a
// snapshot written without lastOkAt clobbers the field on the shared live endpoint
// and the down-escalation goes dead on that deploy:
//   - scripts/refresh-loop.js  (laptop daemon; local snapshot persists between cycles)
//   - scripts/fetch-live.js     (GitHub Actions refresh.yml; fresh checkout, data git-
//     ignored -> seed from the live site instead)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Returns `sources` with a `lastOkAt` (ISO string) added per adapter: now if the
// adapter is ok this run, else its previous lastOkAt carried forward (or null if it
// has never been seen succeeding). prevOk is seeded from the local snapshot when it
// exists, else fetched from `liveUrl` so a fresh CI checkout still has history.
export async function attachSourceHistory(sources, { outDir, liveUrl } = {}) {
  const prevOk = {};
  const seed = (snap) => {
    for (const s of snap?.sources || []) if (s.lastOkAt) prevOk[s.id] = s.lastOkAt;
  };
  try {
    const local = outDir && join(outDir, "health.json");
    if (local && existsSync(local)) {
      seed(JSON.parse(readFileSync(local, "utf8")));
    } else if (liveUrl) {
      const r = await fetch(liveUrl, { signal: AbortSignal.timeout(5000) });
      if (r.ok) seed(await r.json());
    }
  } catch {}
  const nowIso = new Date().toISOString();
  return sources.map((s) => ({ ...s, lastOkAt: s.ok !== false ? nowIso : prevOk[s.id] || null }));
}
