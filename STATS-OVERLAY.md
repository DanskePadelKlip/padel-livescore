# Changeover stats overlay

Built overnight 2026-08-29 on the 3090, branch `stats-overlay`. **Not deployed** —
padelticker.com deploys only from the laptop (see the deploy step at the bottom).

A transparent OBS Browser Source that sits alongside the DPK scoreboard and, during
side changes only, brings up a stats card about the match in progress. It renders
nothing the rest of the time — **a blank page is the normal resting state**.

---

## The finding that changed the design

The build brief said neither provider ships a point log and that every point-level
statistic would therefore have to be sampled by our own poller. **That is not true
for Sporteaser.** Its `pointHistory` field is a complete point-by-point log of the
whole match: every set, every game, every point, with break/set/match-point markers
and exact per-set durations.

Measured against the whole of FIP Gold Belgrade 2026 (sporteaser tournament 397):
**40 matches, 748 games, 3,911 logged points, 100% of played matches carrying a log.**

So the overlay has a real **exact tier** on Sporteaser-scored events — holds, breaks,
break points, points won, service points — none of it sampled, none of it able to be
corrupted by a missed poll. The sampled tier still exists and still matters: it is
what the **Crionet** feed gets, because that one really is current-state-only.

Three things in that log are wrong often enough to matter, and are worked around
rather than trusted:

| Field | Problem | What the overlay does instead |
|---|---|---|
| `status.onServe.homeOnServe` | 21 of 85 sets have a non-alternating server sequence, which the rules of the sport forbid | Reconstructs the server from strict alternation by cumulative game index, picking the parity by majority vote over the flags (94.4% agreement, median match 100%) |
| `serverWonGame` | Inherits the same bad flag — 30/748 disagree with the score | Ignored. A hold/break is (reconstructed server == game winner) |
| per-point `homeOnServe` in tiebreaks | Fails the 1-2-2 serve pattern in 3 of 12 tiebreaks | Ignored. TB serve order is derived from the rule |

When the serve reconstruction fits worse than 80%, **every serve-derived stat is
withheld rather than shown** (4 of 40 matches in the fixture set). One other quirk
worth knowing: the deciding point of a game is never listed — the log ends on the
state *before* it — so points-per-game is `points.length + 1`, verified on all 760
scored games.

---

## What got built

| File | What it is |
|---|---|
| `scripts/live-detail-check.js` | Preflight CLI — run it before going on air |
| `functions/api/live-detail.js` | Read-only CORS relay, GET only, zero writes |
| `public/overlay/stats.html` / `stats.js` / `stats.css` | The overlay itself |
| `public/overlay/accumulator.js` | All the stat maths — dependency-free, shared by the browser and the tests |
| `src/live-detail.js` | Upstream URLs + headers, shared by the adapters and the edge |
| `test/replay.js` / `render.js` / `relay.js` | Offline test path (87 checks, all passing) |

`src/adapters/fip.js` and `sporteaser.js` changed only in that their endpoint
constants moved into `src/live-detail.js` (the edge cannot import linkedom, so the
constants had to live somewhere both sides can reach) and three internal functions
gained an `export`. **No behaviour change** — verified by running the real
`scripts/fetch-live.js` end to end: FIP discovery, the Crionet board and the
Sporteaser overlay all produce what they did before.

---

## Before a broadcast: the preflight

```bash
node scripts/live-detail-check.js fip-gold-belgrade
```

It reports whether live scoring is configured at all, which provider has it, the
sporteaser `tournamentId`, and what fields actually come back — then prints the exact
overlay parameters to use. `--list` shows every FIP event in play; `--day=N` probes a
specific day-of-month.

**An event with no live scoring is a normal outcome, not a failure.** Coverage is
configured per event by the organiser. If the preflight says there is nothing, the
overlay will have nothing to show and there is no point adding the source.

Real output from tonight:

```
Sporteaser
   tournamentId  : 397
   play days     : 24, 25, 26, 27, 28, 29, 30   (day-of-month, not ordinals)
   with point log: 8/8
      POINT LOG     : yes — 2 set(s), 16 game(s), 83 logged point(s)
      set durations : {"set1":"00:27","set2":"00:30"}

Verdict
   Sporteaser, WITH a point log. The overlay gets its exact tier.
   Overlay params:  ?tid=397&day=<day-of-month>&court=<court>
```

---

## The OBS Browser Source

Add a Browser Source, **1920 × 1080**, transparent, URL:

```
https://padelticker.com/overlay/stats.html?tid=397&day=29&court=Centralni&delay=30
```

Tick **"Shutdown source when not visible"** off — the overlay accumulates state and
needs to keep running. A reload does not lose the match: state is mirrored to
`localStorage` per match id.

### Parameters

| Param | Default | What it does |
|---|---|---|
| `tid` + `day` | — | Sporteaser tournament id and **day-of-month** (not a play-day ordinal). From the preflight. |
| `event` | — | Crionet event id (`FIP-2026-3507`) instead of `tid`/`day`. Sampled tier only. |
| `court` | — | Follow the match on this court (substring, case-insensitive) |
| `player` | — | Follow the match with this player in it (substring) |
| `match` | — | Sporteaser match id — the unambiguous way, and the cheapest (the relay then ships one match instead of the whole ~500 KB day) |
| **`delay`** | `0` | **Seconds to hold every card by. Set this.** See below. |
| `sampled` | off | Show the approximate point counters. Only meaningful on Crionet events. |
| `theme` | `dark` | `light` / `dark`, matching the scoreboard palette |
| `pos` | `bottom-left` | `bottom-left` / `bottom-right` / `top-left` / `top-right` |
| `scale` | `1` | Scales the whole card — use `0.67` on a 720p canvas |
| `show` | `50` | Total seconds of card time per changeover |
| `poll` | `3000` | Poll interval in ms (floor 1500) |
| `debug` | off | On-screen log of polls, state and triggers. Use while setting up. |
| `preview` | — | Pin one card (`serve`/`games`/`points`/`time`/`context`) on screen so you can position the source without waiting for a changeover. **Never on air.** |

### `delay` is the parameter that matters

If the stream is a relay of an HLS feed, the video viewers see is **20–40 s behind
real court time**. The overlay reads the live feed, which is at real court time. With
`delay=0` a card fires while viewers are still watching the game that triggered it —
it spoils the point and it looks broken.

Set `delay` to your measured stream latency. The overlay subtracts it from the length
of the break, so cards still finish before play resumes. If the delay leaves less than
12 s of usable window, **the card is skipped entirely** rather than run over the start
of the next game. That is deliberate: nothing on screen beats something on screen at
the wrong moment.

Windows used: 75 s for an odd-game changeover, 105 s at a set break, 25 s for a
tiebreak swap, each minus `delay` and a 6 s safety margin.

### When cards appear

- **Changeover** — when the total games in the set becomes odd, from the third game on
  (there is no sit-down after the first game of a set)
- **Set break** — when a set completes, or when a new set appears in the feed
- **Tiebreak** — every 6 points, one card only

Two to three cards rotate within one changeover, and the rotation advances between
changeovers so consecutive breaks do not show the same pair. A break of serve puts the
serve card first; a set break leads with games.

---

## Exact vs sampled

**Exact tier** — derived from the Sporteaser point log plus rule-based serve
reconstruction. Cannot be corrupted by a missed poll, because it is re-derived from the
whole log on every fetch rather than accumulated:

- service games won / played, breaks (total and this set)
- break points faced / saved / converted
- points won, service points won
- games set by set, current run, momentum over the last 6 games
- **set durations** (exact, from the feed's own `meta.duration`)

**Observed, not published** — game durations and "longest game" are wall-clock
measurements the overlay takes itself, so they only cover games it was running for.

**Sampled tier** (`sampled=1`, Crionet events) — accumulated by diffing polls, and
always rendered with a red `Approximate — sampled from polling` footer. Each game is
reconciled when it ends: the winner must have won at least 4 points (7 in a tiebreak).
If the poller missed a transition, that game is **marked unreliable and excluded**
rather than reported short, and the count of dropped games is shown on the card.

**Context tier** — H2H, the team-vs-team tally and Elo, fetched once per match from
`/api/matchup`, `/api/search` and `/api/player/:id`. Live-feed names do not always
resolve to a profile; when they do not, **the card is dropped silently**. Elo is only
shown when both sides' ratings come from the same (source, pool) — a men's FIP rating
against a women's RankedIn one is a category error, not a comparison.

---

## What is NOT verified

Be aware of these before trusting it live:

1. **No live match was observed.** This was built 01:00–02:30, when nothing was on
   court anywhere on tour. Everything is verified against *recorded* data: finished
   matches replayed point by point with synthetic time. The relay was called against
   the real live upstreams and returns real payloads, but no *in-progress* match ever
   passed through it.
2. **The Crionet path is unverified against live markup.** No FIP event anywhere had a
   populated Crionet live board tonight — every one was empty. The parser mirrors
   `parseLiveBoard()` in `src/adapters/fip.js` and additionally reads the `td.set`
   cells, which that function does not extract, so **the set-games selector on the
   Crionet path has never been run against real HTML**. Changeover detection depends on
   it. The empty-board case is covered by a real fixture and is safe.
3. **`pointHistory` during live play is inferred, not observed.** Every log in the
   fixtures is from a finished match. The existing sporteaser adapter already reads
   `pointHistory` for the serving side on *live* matches and was verified doing so on
   2026-08-26, which is good evidence it populates in real time — but I did not see it
   myself.
4. **Nothing was rendered in a browser.** A dev server cannot be started in an
   unattended run. Cards are verified by rendering them through a synthetic DOM
   (`test/render.js`) — that catches throws, `undefined`/`NaN` and an unlabelled
   sampled number, but **not** whether the CSS looks right at 1920×1080. Positioning
   wants your eyes and an OBS preview.
5. **Edge cache behaviour is unproven.** `max-age=2` plus `cf.cacheTtl` should collapse
   many overlay instances onto one upstream fetch; only a deploy shows whether it does.

### The first live test

Belgrade's finals are the obvious one. Semi-finals were scheduled for 2026-08-29 at
13:00 and 16:30 UTC on Centralni Teren 2 — by the time you read this, run the preflight
again for the current day and use whatever it prints:

```bash
node scripts/live-detail-check.js fip-gold-belgrade
```

Then open the overlay with `&debug=1` in a normal browser first and watch the log fill
in before putting it in OBS.

---

## Tests

The branch was built in a worktree at `..\padel-livescore-stats-overlay` so the
dirty `fip-estimate-turnover` tree in the main checkout was never touched. A fresh
worktree has no `node_modules` — run `npm install` in it before `npm test`, and do
**not** symlink or junction the main checkout's `node_modules` into it: a later
`rm -rf` of the worktree would follow the link and take the real one with it.

```bash
npm test
```

87 checks across three files, all passing (49 replay + 25 render + 13 relay):

- `test/replay.js` — replays real captured payloads point by point through the
  accumulator with synthetic time. Covers a 6-4 set (4 changeovers, hold/break tally),
  a tiebreak set, a poll gap that drops a point (reconciliation marks it unreliable
  instead of reporting a wrong total), a day with no point history at all, trigger
  de-duplication, and an internal-consistency sweep over all 40 fixture matches / 760
  games.
- `test/render.js` — renders every card through a synthetic DOM.
- `test/relay.js` — the relay's parameter validation and CORS. `npm run test:live`
  additionally hits the real Sporteaser and Crionet upstreams.

Fixtures in `test/fixtures/` are untouched captures from 2026-08-29.

---

## Deploying (laptop only)

The 3090 must not deploy this. padelticker.com deploys only from the laptop, and its
refresh daemon reverts anything deployed from anywhere else. On the laptop:

```bash
git fetch && git checkout stats-overlay
```

```bash
npm test
```

```bash
./deploy.ps1
```

Then check the live relay answers before adding the OBS source:

```bash
curl -s "https://padelticker.com/api/live-detail?tid=397&day=29" | head -c 300
```

Nothing in this branch touches the live data path — no KV writes, no D1 writes, no
change to `scripts/refresh-loop.js`, `scripts/fetch-live.js` or the aggregate layer.
The only shared-code change is the endpoint constants moving into `src/live-detail.js`.
