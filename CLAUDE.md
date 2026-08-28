# padel-livescore — working rules

Read this before editing. Two of these rules exist because breaking them is
invisible until it is live.

## 1. The working tree IS production. There is no staging.

`scripts/refresh-loop.js` runs `wrangler pages deploy public` **every cycle, from
whatever is on disk** — not from a commit, not from a branch, not from CI. An
unfinished edit sitting in the working tree ships on the next cycle whether or not
you committed it.

This also means a deploy carries files you did not touch, including any local
modifications someone else left behind. Check `git status` before assuming you know
what a deploy will contain.

## 2. Do not make incidental changes while matches are live

The loop is self-pacing, so the window between "I saved a file" and "the world has
it" depends entirely on whether anything is on court:

| state | sleep | edit-to-live window |
|---|---|---|
| ≥ 1 match live | 20 s (+ ~35 s cycle work) | **under a minute** |
| only upcoming | 10 min | ~10 min |
| nothing on | 30 min | ~30 min |

With something live you cannot verify an edit before it reaches users. With nothing
live you have a real window to change, check, and back out. So: **no incidental
changes while `live > 0`.** Check first —

```bash
curl -s https://padelticker.com/data/matches.json | grep -o '"status":"live"' | wc -l
```

Gate on live **status alone**, not on whether the board shows a score. A match can be
`status: "live"` with a completely blank board — that is exactly the Crionet gap
`src/adapters/sporteaser.js` exists to fill, and it is the *more* fragile case, not a
safer one.

**What counts as reaching production:** `public/`, `functions/`, and `src/` (it
generates `matches.json`). Root-level docs, `README.md`, and scripts off the loop path
do not — this file was added during a live match for exactly that reason.

**Carve-out — the live path itself.** You cannot debug live scoring when nothing is
live; `sporteaser.js` was written and verified against a live FIP Gold Belgrade match.
Fixing something *because* it is broken on court is the one change that belongs during
live play. Restore known-good quickly if it does not work.

## 3. Deploys run on the laptop, and only on the laptop

`LEGION_AI` (`C:\Users\Dansk\AI Projects\padel-livescore`) is the always-on node. It
runs the refresh daemon, and it is the only box that may deploy — **not because of
where the API token lives, but because `public/data/matches.json` and
`rankings.json` are gitignored yet served as static assets.** They are generated
there. Deploy from any other checkout and the live feed ships stale or missing, and
the tracked `public/data/archive/` rolls back with it.

Other machines can hold checkouts and develop freely; they simply cannot deploy.
`deploy.ps1` fails closed elsewhere because it sources a token file that only exists
on the laptop. Do not "fix" that.

## 4. You are probably not the only writer

Several actors touch this repo independently — the refresh daemon, cloud routines
pushing to `main`, and interactive sessions on more than one machine. Trees have been
edited mid-merge more than once.

- Before merging or committing on a shared checkout, check `LastWriteTime` on
  `public/app.js` and `public/index.html`. Recent movement means stop.
- The daemon rewrites `public/index.html` (the `app.js?v=<sha1>` cache-bust stamp) and
  `public/data/*` continuously, and runs `git checkout FETCH_HEAD --
  public/data/archive/wpt.json` **into the index**. That is why `wpt.json` shows as
  permanently *staged* — nobody staged it by hand. Never sweep it into a commit; use
  `git commit -- <paths>` rather than a bare `git add`.
- A large `wpt.json` diff means HEAD is behind, not that anything is wrong. It
  disappears on its own once the checkout catches up.

## 5. Verify a deploy against the live bytes

The wrangler output says a deployment succeeded, not that users are getting your
change. Hash what is actually served:

```bash
curl -s https://padelticker.com/app.js | sha256sum
```

Deleting an asset is slower than it looks: it leaves the next deployment immediately,
but Pages serves assets `s-maxage=604800`, and the cache purge API **cannot evict
them** — the copies live in Pages' own layer (`cf-cache-status: DYNAMIC`), which
purge-by-URL and `purge_everything` both report success against while changing
nothing. The only lever is time, up to 7 days.
