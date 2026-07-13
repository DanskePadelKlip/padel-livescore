// Week-over-week movement for the NATIONAL rankings. RankedIn only exposes the
// current week (it ignores the week/year params), and we keep no history — so we
// persist a weekly baseline snapshot on Pages (data/rankings-base.json) and diff
// against it. Movement accrues going forward: the first week shows no arrows,
// then each new ISO week freezes the prior week's ranking as the baseline.
//
// (The FIP world ranking gets real movement a different way — recomputed from
// padel.db history in export_fip_ranking.py — so it needs none of this.)

export function isoWeekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - ys) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

const listKey = (l) => `${l.fed}:${l.category}`;

// { "DK:men": { "<playerId>": rank, … }, … } — only rows we can track (have an id)
export function ranksFromLists(lists) {
  const out = {};
  for (const l of lists || []) {
    const m = {};
    for (const r of l.rows || []) if (r.id != null) m[r.id] = r.rank;
    out[listKey(l)] = m;
  }
  return out;
}

// Mutates `lists`: attaches r.delta (int; null = new to the list) and
// l.movement=true wherever a baseline exists. Returns the baseline object to
// persist for the next run.
export function applyMovement(lists, base, prevLists, weekKey = isoWeekKey()) {
  let baseToWrite, compare;
  if (!base) {
    // first ever run — seed the baseline from the current ranking; no arrows yet
    baseToWrite = { weekOf: weekKey, ranks: ranksFromLists(lists) };
    compare = null;
  } else if (base.weekOf === weekKey) {
    baseToWrite = base; // still the same week — keep the frozen baseline
    compare = base;
  } else {
    // a new ISO week began — freeze the previously-published ranking as baseline
    baseToWrite = { weekOf: weekKey, ranks: ranksFromLists(prevLists) };
    compare = baseToWrite;
  }

  if (compare) {
    for (const l of lists) {
      const prev = compare.ranks[listKey(l)];
      if (!prev || !Object.keys(prev).length) continue;
      l.movement = true;
      for (const r of l.rows) {
        if (r.id == null) continue;
        const p = prev[r.id];
        r.delta = p == null ? null : p - r.rank; // null = new; +up / -down
      }
    }
  }
  return baseToWrite;
}
