// Per-event slices of the live feed: public/data/live-t/<key>.json, one per
// tournament in matches.json, holding exactly the rows the feed carries for it.
//
// /tournament/<source>/<id> for an event with no archive file used to find its rows
// by parsing the whole of data/matches.json: 9.1 MB as deployed (pretty-printed,
// ~5,400 matches), several times the free plan's 10 ms CPU a request, on URLs the
// sitemap lists as changefreq hourly. Both producers now write these slices each
// cycle and the route reads one of them instead.
//
// Pure, so the producers (src/live-tournaments-node.js) and the route
// (functions/tournament/[source]/[id].js) share one definition of a file name.

// "<source>-<id>", lowercased: the laptop's NTFS is case-insensitive, so two ids
// differing only in case would overwrite each other there but not on CI's Linux
// runner. The route filters a slice by the exact source and id, so two events
// folding onto one file both still resolve. An id outside a plain filename
// alphabet gets no file (null); the feed had none on 2026-10-21.
export function liveTournamentKey(source, id) {
  const key = `${source}-${id}`.toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*$/.test(key) ? key : null;
}

// rows: the feed's matches. -> { groups: Map key -> rows in feed order, skipped }
export function groupLiveTournaments(rows) {
  const groups = new Map();
  let skipped = 0;
  for (const m of rows || []) {
    const key = m && m.tournament ? liveTournamentKey(m.source, m.tournament.id) : null;
    if (!key) { skipped++; continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return { groups, skipped };
}
