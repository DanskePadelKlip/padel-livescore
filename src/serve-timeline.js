// Per-match game timeline: one JSONL line each time a live match's games tally or
// serving side changes. Score strings ("6-4") lose game ORDER, and order is what
// serve stats need - with it, one observed server (or the hold-majority parity,
// validated 0 wrong / 91 on FIP Gold Belgrade) pins the whole match's serve order.
// The cycle already sees both every poll and used to throw them away.
//
// Written OUTSIDE the repo on purpose: public/ is deployed every cycle and this is
// raw capture, not site data. Never let a write failure reach the cycle.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.env.PADEL_TIMELINE_DIR || join(homedir(), "padel-timelines");
const FORGET_MS = 6 * 3600 * 1000; // drop state for matches not seen in 6h

const last = new Map(); // id -> { key, seen }

const stateKey = (m) =>
  JSON.stringify([m.status, m.score?.sets || [], m.score?.serving ?? null]);

// Returns the number of lines written (for the cycle log).
export function recordTimeline(matches, now = new Date()) {
  let wrote = 0;
  try {
    const lines = [];
    const t = now.toISOString();
    for (const m of matches) {
      const prev = last.get(m.id);
      // Live rows, plus the one transition to final so the closing tally lands.
      if (m.status !== "live" && !(prev && m.status === "final")) continue;
      const key = stateKey(m);
      if (prev && prev.key === key) { prev.seen = now.getTime(); continue; }
      last.set(m.id, { key, seen: now.getTime() });
      lines.push(JSON.stringify({
        t,
        id: m.id,
        src: m.source,
        tid: m.tournament?.id ?? null,
        st: m.status,
        sets: m.score?.sets || [],
        sv: m.score?.serving ?? null,
        teams: (m.teams || []).map((x) => x.name),
      }));
    }
    for (const [id, v] of last) if (now.getTime() - v.seen > FORGET_MS) last.delete(id);
    if (lines.length) {
      mkdirSync(DIR, { recursive: true });
      appendFileSync(join(DIR, `${t.slice(0, 10)}.jsonl`), lines.join("\n") + "\n");
      wrote = lines.length;
    }
  } catch (e) {
    console.error("  timeline write skipped:", e.message);
  }
  return wrote;
}
