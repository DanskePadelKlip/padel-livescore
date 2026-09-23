// Finished FIP championship rubbers, kept after the source stops serving them.
//
// postafip.puntuate.com has no date parameter: it serves the CURRENT DAY and
// nothing else. So at the day rollover every result from the day before leaves
// the feed at once - on 22 Sep that was both Danish ties, three rubbers each,
// which a board was still being asked to show. A championship also edits its
// own rows mid-event (a finished rubber lost its nations and tie score hours
// after it was played), so "it was there an hour ago" is not a guarantee either.
//
// This keeps the finals we have already seen and merges them under whatever the
// source says now. LIVE ALWAYS WINS: an archived row only ever fills a gap, so
// a correction upstream still reaches the board on the next poll and can never
// be overwritten by yesterday's copy of itself.
//
// Deliberately no fs and no Node APIs: the daemon reads and writes the file,
// the Pages Function fetches the deployed copy, and both merge through the same
// two functions so they cannot disagree about precedence.

export const ARCHIVE_VERSION = 1;

// Worth keeping only if it is a finished championship row that actually carries
// a score. A "final" with no sets is a parse artefact - FIP's row shapes drift
// mid-event - and archiving one would pin that artefact on the board for the
// rest of the week, long after the parser was fixed.
export function archivable(m) {
  if (!m || m.source !== "puntuate" || m.status !== "final") return false;
  const sets = (m.score && m.score.sets) || [];
  if (!sets.length) return false;

  // A tie row's "sets" is its rubber count ([[3, 0]]).
  if (!/:m\d+$/.test(String(m.id))) {
    const a = Number((sets[0] || [])[0]) || 0;
    const b = Number((sets[0] || [])[1]) || 0;
    // Best of three: a tie is decided when one side has TWO rubbers, not when
    // two have been played. 1-1 is the gap between rubbers, and archiving it
    // froze "the other side won" onto a tie that was still being played.
    if (Math.max(a, b) < 2 || a === b) return false;
    // The emitter reaches the same conclusion; if the two ever disagree, the
    // row is not something to keep for the rest of the week.
    return m.score.winner === 0 || m.score.winner === 1;
  }

  // A rubber read from a half-rendered block can end up with one side holding
  // no players and a column default of zero. It looks like a completed match
  // and is not one, so both sides must actually be named.
  const named = (m.teams || []).filter((t) => t && (t.players || []).length > 0).length;
  return named >= 2;
}

// The event id a row belongs to: "puntuate:2309:Male||1|DNK|SRB" -> "2309".
export function tidOf(id) {
  return String(id || "").split(":")[1] || "";
}

// Fold this run's finals into the archive. Returns a NEW archive object plus a
// count of what changed, so the caller can log it and skip a pointless write.
export function updateArchive(archive, matches, { keepTids = null, max = 5000 } = {}) {
  const kept = { ...((archive && archive.matches) || {}) };
  let added = 0, refreshed = 0;
  for (const m of matches || []) {
    if (!archivable(m)) continue;
    if (kept[m.id]) refreshed++; else added++;
    // The freshest final wins: FIP corrects scores after the fact.
    kept[m.id] = m;
  }
  // Retention is the event list, not a clock: once an event is out of EVENTS
  // the daemon no longer polls it, so its rows can never be refreshed and only
  // grow the file. A hard ceiling underneath that guards against a runaway id.
  let dropped = 0;
  // Re-judge what we already hold. The predicate is the same one incoming rows
  // face, so tightening it retires the rows it would now reject rather than
  // leaving them on air for the rest of the event.
  for (const id of Object.keys(kept)) {
    if (!archivable(kept[id])) { delete kept[id]; dropped++; }
  }
  if (keepTids) {
    for (const id of Object.keys(kept)) {
      if (!keepTids.has(tidOf(id))) { delete kept[id]; dropped++; }
    }
  }
  const ids = Object.keys(kept);
  if (ids.length > max) {
    for (const id of ids.slice(0, ids.length - max)) { delete kept[id]; dropped++; }
  }
  return {
    archive: { version: ARCHIVE_VERSION, matches: kept },
    added, refreshed, dropped, size: Object.keys(kept).length,
  };
}

// Whether a row the source is serving now should replace what we have kept.
//
// Live normally wins: a correction upstream must reach the board. The exception
// is a row that states NOTHING - FIP strips the nations and the tie score off a
// finished row hours later, and that row is newer but emptier. Replacing a
// result with it is how a decided tie regressed to "not started" on air.
export function supersedes(incoming, archived) {
  if (!archived) return true;
  const now = ((incoming && incoming.score && incoming.score.sets) || []).length;
  const kept = ((archived.score && archived.score.sets) || []).length;
  return now > 0 || kept === 0;
}

// Archived rows FIRST so that anything the source serves now overwrites them.
// The caller passes both lists to the same merge the pipeline already uses, so
// ordering and de-duplication stay in one place.
export function archivedRows(archive) {
  return Object.values((archive && archive.matches) || {});
}
