-- Rebuilds the `pairs` roll-up: one row per partnership, most-played first.
--
-- WHY THIS EXISTS. /api/pairs originally derived this live. Measured against a
-- copy of the real archive (100,144 matches / 399,042 match_players rows) that
-- GROUP BY takes ~2.7 s — too slow to run inside a request even behind a cache,
-- and the kind of whole-table scan D1 is entitled to refuse outright. Reading it
-- from this table instead is sub-millisecond. Same pattern as player_elo and
-- player_bio: derived data is loaded by a separate step, and the API degrades to
-- computing it live if the table isn't there yet.
--
-- RUN IT (a write, so it needs a D1: Edit token):
--   wrangler d1 execute padelticker-history --remote --file scripts/pairs-rollup.sql
-- Re-run after an archive import; the answer only moves when tournaments finish.
--
-- HAVING >= 2 is what the LISTINGS are drawn from (/pairs and the sitemap): a
-- pair with a single match is a page with one row on it, and 22k of those is how
-- a sitemap turns into thin content. It does NOT gate the pages themselves —
-- /pair/:a/:b computes from match_players and works for any two players who
-- have ever shared a side, reachable from their profiles and from match rows.

CREATE TABLE IF NOT EXISTS pairs (
  a TEXT NOT NULL,          -- the two player ids, always a < b (canonical URL order)
  b TEXT NOT NULL,
  na TEXT, nb TEXT,         -- display names, preferring `players` over the match rows
  ca TEXT, cb TEXT,         -- countries, same preference
  played INTEGER NOT NULL,
  won INTEGER NOT NULL,     -- wins from side `a`/`b` (they share a side, so it's the pair's)
  last TEXT,                -- most recent match date, used as the sitemap lastmod
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS idx_pairs_played ON pairs(played DESC);

DELETE FROM pairs;

INSERT INTO pairs (a, b, na, nb, ca, cb, played, won, last)
SELECT p1.player_id, p2.player_id,
       COALESCE(ja.name, p1.name), COALESCE(jb.name, p2.name),
       COALESCE(ja.country, p1.country), COALESCE(jb.country, p2.country),
       COUNT(*), SUM(CASE WHEN p1.is_winner = 1 THEN 1 ELSE 0 END), MAX(m.date)
FROM match_players p1
-- `p2.player_id > p1.player_id` both de-duplicates the partnership (each duo is
-- counted once) and stores it in the same order /pair/:a/:b canonicalises to.
JOIN match_players p2 ON p2.match_id = p1.match_id AND p2.side = p1.side AND p2.player_id > p1.player_id
JOIN matches m ON m.id = p1.match_id
LEFT JOIN players ja ON ja.id = p1.player_id
LEFT JOIN players jb ON jb.id = p2.player_id
WHERE p1.player_id IS NOT NULL
GROUP BY p1.player_id, p2.player_id
HAVING COUNT(*) >= 2;
