# National teams (international) — progress & report

Branch `national-teams-international`, off `origin/main` @ 7b9aa7e.
Headless run on the 3090, 2026-09-15 23:00. **Research/build only — nothing shipped.**

Goal: an international national-team championship section on PadelTicker — every nation's
placing, clickable countries, each championship opening its archived draw. Explicitly *not*
Denmark's results table, which stays on danskepadelklip.com/landshold.

---

## 1. Coverage — what is sourced, and what is not

Everything below comes from draws already in this repo (`public/data/archive/t/`). Nothing was
typed in from memory, a news article or a search result.

### Sourced

| Championship | Year | Cat. | Gender | Nations placed | Also entered, no placing | Source |
|---|---|---|---|---|---|---|
| FIP World Padel Championships | 2024 | Senior | men | **16** (1–16) | — | draw `fip-135412`, placement bracket |
| FIP World Padel Championships | 2024 | Senior | women | **16** (1–16) | — | draw `fip-135412`, placement bracket |
| FIP Junior Euro Padel Cup | 2026 | Junior | men | **8** (1–8) | 14 | draw `fip-296741`, placement bracket |
| FIP Junior Euro Padel Cup | 2026 | Junior | women | **8** (1–8) | 11 | draw `fip-296741`, placement bracket |
| FIP Junior Africa Padel Cup | 2026 | Junior | men | **3** (1–3) | — | draw `fip-296740`, final + round robin |
| FIP Junior Africa Padel Cup | 2026 | Junior | women | **3** (1–3) | — | draw `fip-296740`, final + round robin |

**54 placings, 35 nations, 3 editions.** The full derived tables are in
`public/data/national-teams.json`; `node scripts/build-national-teams.mjs` regenerates them.

### Not sourced — and exactly why

| Championship | Year | Key | Why nothing could be sourced |
|---|---|---|---|
| FIP European Padel Championships (Cagliari) | 2024 | `fip-137970` | The archived draw has **no round labels and no dates** on any of its 287 ties, so they cannot be ordered into a bracket. |
| FIP Juniors European Championships *by teams* (Budapest) | 2024 | `rin-42477` | RankedIn team ties export with **`score.winner === 0` on all 76 matches** and a set score that is not a result. The position rounds (`Position 1-8`, `9-12`, `9-16`) are labelled but hold no outcomes. |
| Nordic Team Championships (Drammen) | 2025 | `rin-47618` | Same: `winner = 0` on all 36 ties. |
| Arla Protein Nordic Team Championships | 2026 | `rin-63840` | Same: `winner = 0` on all 48 ties. |
| FIP World Cup **Pairs** | 2025 | `fip-232889` | Out of scope by the brief — a pairs event, not national teams. See question 3. |

Consequences worth naming:

* **No Veteran category is covered at all.** Every veteran edition Denmark's old table carried
  (FIP European Veterans, the Nordics) is either in the gap list above or not in the archive.
  The category chips therefore show Senior and Junior only.
* **Only 2024 and 2026 are covered.** The archive holds no earlier world or European
  championship: the five events under the `world-championships` / `european-championships` /
  `fip-championship` categories are exactly the ones listed here. The archive itself spans
  2020-01-17 → 2026-07-10 and is complete for those categories.
* The Denmark-only table that was removed carried 22 rows back to 2019; **most of that history
  is not reproducible from the archive** and would need a hand-sourced final classification.

### Attempts to close the gaps (all failed, none quietly)

* `widget.matchscorerlive.com/screen/oopbyday/<id>/<day>` — the day-by-day path the FIP adapter
  uses, which would supply round order even with empty round labels — **404s for all three FIP
  ids tested** (137970, 135412, 296741). The widget no longer serves finished tournaments there.
* padelfip.com's own 2024 European event page has the 1-4 / 5-8 / 9-12 / 13-16 playoff brackets
  as *video sections only*; it publishes no classification table (checked directly).
* padel-magazine.co.uk's "Euro Padel 2024 – rankings and final results" page returned **504**.

A web search summary asserted Denmark played Belgium for 9/10 (men) and Germany for 7/8 (women)
at Cagliari, which agrees with the old table's 10th/8th — but a search-engine paraphrase is not a
source, so nothing from it went into the data.

---

## 2. Why the placings are reading, not inference

Worth a minute of review, because "derive the standings from the results" is normally exactly the
thing that puts invented facts on a site.

FIP team championships are played as a **full placement bracket**. The round FIP labels `Final`
in the 2024 world championship is **eight ties**, one per position pair — 1/2, 3/4, 5/6 … 15/16
— not one gold-medal match. Every nation keeps playing until it has an exact place, so the draw
*states* all sixteen placings; the script reads them off it.

The one thing the bracket does not state is which half of the post-group split is the
championship half. That comes from the group table, and only when the group is decided on ties
won with a **strict gap at the split line** — so no federation tie-break rule is ever needed,
guessed or invented. If a group is level there, the event emits nothing.

Every structural check in `scripts/build-national-teams.mjs` is a **refusal, not a warning**: a
draw that does not pair its blocks within themselves, halve cleanly, or resolve to one nation per
position produces no rows at all and is reported as a gap. A missing placing is recoverable; a
wrong one is not.

**Independent verification.** `node scripts/build-national-teams.mjs --check` re-derives Denmark
and compares it to the removed Denmark-only file, whose 22 rows were sourced one at a time
(official draw / final classification / DPF) with no reference to any bracket walk:

```
check fip-135412 women DEN: expected 10, derived 10 OK
check fip-296741 men   DEN: expected  7, derived  7 OK
check fip-135412 men   DEN: absent OK (Denmark did not qualify)
```

Plus: positions must form a clean 1..N permutation per edition and gender. The medals also match
what is publicly known — Argentina beat Spain for the 2024 men's world title, Spain beat
Argentina for the women's.

---

## 3. What is on the branch

| Commit | What |
|---|---|
| `8303e8a` | this progress doc, started |
| `ce888dc` | `scripts/build-national-teams.mjs` + `public/data/national-teams.json` |
| `735114a` | the section itself: app.js, index.html, functions, sitemap, headless test |

Files:

* **`scripts/build-national-teams.mjs`** — the derivation, the event list, the gap list, the
  IOC→ISO/name table, and `--check`. Re-runnable: rerun and diff.
* **`public/data/national-teams.json`** — `events` / `countries` / `rows` / `gaps`. Committed,
  like the old one was.
* **`public/app.js`** — `natteams` mode, `loadNatTeams`, `renderNatTeams`, category + gender
  chips, `/national-teams/<gender>/<category>` routing, `countryRankingTarget` /
  `openCountryRanking`.
* **`public/index.html`** — nav button (`🏅 National teams`) and the `.nt-*` CSS.
* **`functions/national-teams.js`** — `hub("national-teams")`; the 301 to
  danskepadelklip.com/landshold is gone.
* **`functions/national-teams/[[path]].js`** — new. The filter slices get the section's meta and
  canonicalise to `/national-teams` instead of falling through to the app shell's homepage
  canonical (which is what `/earnings/men` still does on main).
* **`functions/_hubs.js`**, **`functions/sitemap.xml.js`** — hub entry; sitemap lists
  `/national-teams` only, deliberately (a sitemap URL that canonicalises elsewhere is what cost
  the site its hub pages in 2026-07).
* **`scripts/test-national-teams.mjs`** — new. See below.

### How it was tested

No browser on this box, so:

* `node -e "new (require('vm').Script)(require('fs').readFileSync('public/app.js','utf8'))"` — parses.
* `node --check` on all four touched function files — pass.
* `node scripts/build-national-teams.mjs --check` — all checks pass (above).
* **`scripts/test-national-teams.mjs`** runs `public/app.js` *for real*, inside a linkedom DOM
  with `fetch` / `localStorage` / `history` / `location` stubbed, and asserts on state and
  rendered HTML. **26 checks, all passing:** routing to `natteams`, the data loading, every row
  resolving to a listed edition, the country links / draw link / chips rendering, Denmark's two
  sourced placings and its absence from the men's 2024 worlds, the category and gender filters,
  cold-open of the `fip-135412` draw (263 matches, URL `/tournament/fip/135412`) and the return
  to the table, both deep-link paths, and that **all 35 clickable nations reach a non-empty
  ranking**.

  ```
  NODE_PATH="../padel-livescore/node_modules" node scripts/test-national-teams.mjs
  ```

  (`linkedom` is a dependency of the main checkout; the worktree has no `node_modules`.)
* `node scripts/serve.js` + curl: `/national-teams`, `/national-teams/women` and
  `/data/national-teams.json` all 200. `serve.js` is static, so this does **not** exercise the
  Pages Functions — the hub meta and the `[[path]]` catch-all are unverified at runtime.

That test found one real bug, now fixed: `renderRankings` silently clears `state.rankNat` when
the chosen list holds nobody of that nationality, so clicking **Uruguay** in the women's 2024
table would have dropped the visitor on the unfiltered 1,000-row FIP world list — a page about
everyone, reached by clicking one country. `countryRankingTarget` now falls back to the other
gender's list when the current one has nobody.

### Unfinished / where to resume

* Nothing is half-built; the section is complete and self-consistent as it stands.
* The obvious next increment is **coverage, not code**: the four gap events need a final
  classification from outside this repo. If one is found, add an entry to `EVENTS` (if the draw
  gains round labels) or introduce a small hand-sourced rows file with a per-row `source` — the
  renderer already prints `e.source` per edition.
* Pages Functions were never executed. To check before merge: `npx wrangler pages dev public`
  from the worktree.

---

## 4. Open questions for Kim — please decide these, I did not

1. **Where should a country click go?** Built as briefed: the nation's own ranking where
   PadelTicker publishes one (DK, SE, DE, HR, EE, GE, HU, UA, SI, XK, BA, ME), otherwise the FIP
   world list filtered to that nationality. Two things to weigh: the FIP nationality filter is
   **not deep-linkable** (`rankNat` is not in the URL), so the destination cannot be shared; and
   a national ranking is a *domestic* list, a slightly different thing from "this country's
   national team". Alternatives: a per-country page listing that nation's placings across all
   championships (more work, arguably the more natural click), or no country link at all.
2. **Which championships, and how far back?** Right now: whatever the archive can prove, which is
   2024 + 2026 and Senior + Junior only. Do you want veteran and pre-2024 editions hand-sourced,
   and if so from what — DPF, FIP PDFs, something else?
3. **Pairs events.** `fip-232889` FIP World Cup Pairs 2025 is excluded as a pairs event. Should
   "national teams" include national *pairs* competitions (World Cup Pairs, and `rin-42482`, the
   pairs half of the 2024 juniors Europeans), clearly labelled?
4. **The "also entered" list.** 14 men's and 11 women's nations played the 2026 junior Euro Cup
   qualifying groups without reaching a placement bracket. They are currently listed by name
   under each table with no position. Keep, or drop them?
5. **Sitemap.** Only `/national-teams` is listed, not the gender slices — unlike `/earnings`,
   which lists `/earnings/men` and `/earnings/women` even though those canonicalise to
   `/earnings`. Worth fixing earnings the same way?

---

## 5. In-browser checks to run on review

Serve the branch locally first — `node scripts/serve.js` from this worktree, then
`http://localhost:8787`. Copy `matches.json` and `rankings.json` from padelticker.com into
`public/data/` first (both gitignored; the app fetches `matches.json` before it routes at all).

1. `/national-teams` — the section loads, nav button `🏅 National teams` is active, three
   championship cards (2026 Junior Africa, 2026 Junior Euro Cup, 2024 World Championship), men's
   tables, medal-coloured 1/2/3.
2. Category chips **All / Senior / Junior** and gender chips **Men / Women** — switching each
   rewrites the URL to `/national-teams`, `/national-teams/women`, `/national-teams/women/junior`
   etc. Reload each of those URLs: the same view comes back.
3. Click **"World Championship 2024"** (the title, not the row) — the archived draw opens at
   `/tournament/fip/135412`. Back out; the national-teams table returns.
4. Click **Denmark** in the 2024 women's table — lands on `/rankings/DK/women`.
5. Click **Argentina** — lands on the FIP world ranking with the *Nationality* dropdown set to
   `ARG`. Note the URL says only `/rankings/FIP/men` (question 1).
6. Click **Uruguay** in the **women's** 2024 table — must land on the FIP **men's** list filtered
   to URU (there is no Uruguayan in the women's top 1000), *not* an unfiltered list.
7. Switch to **Junior**, women — Estonia is 8th in the Euro Cup, and the "also entered" line
   under the table shows flags and names, each clickable.
8. Type **"spain"** into the search box — only Spain's rows remain, across both editions; the
   gaps block hides while a query is active.
9. Scroll to **"Not sourced yet"** — four entries, each with its reason.
10. Dark and light mode, and a phone width: the tables scroll horizontally rather than
    overflowing, and the `via` column ("beat ESP 2-1 in the final") wraps.

---

## 6. Exactly what shipping would take — Kim's call, not done here

1. Review and merge the branch to `main`
   (`git checkout main && git merge --ff-only national-teams-international`, or a PR).
2. Push `main`. **This alone does not ship** — CI deploys `main` on a schedule, but the laptop's
   refresh daemon re-deploys the laptop's *working tree* every cycle and would revert it within
   minutes (the 2026-09-09 earnings incident).
3. **Fast-forward the laptop checkout** `C:\Users\Dansk\AI Projects\padel-livescore` on
   LEGION_AI. Its only local edit is the daemon's `app.js?v=` stamp in `index.html`, safe to
   discard. The next daemon cycle deploys it.
4. Verify with a **cache-busted GET** (not HEAD) of `https://padelticker.com/index.html` — the
   `?v` hash should change — then `/national-teams` for the self-canonical and `/sitemap.xml` for
   the new entry. Confirm `/data/national-teams.json` serves the 54 rows.
5. Confirm the old redirect is gone: `/national-teams` must no longer 301 to
   danskepadelklip.com/landshold.
6. No D1 write and no Meta/API token is involved. Nothing else to roll.

To roll back: revert the merge and fast-forward the laptop again; `/national-teams` returns to
the 301.

---

## 7. Run notes

* **Local model: skipped.** The router answered on `127.0.0.1:8080` (401, needs the token) but
  vLLM on `:8000` refused the connection — the local rung was **not already up**, and the brief
  forbids starting it or taking the GPU lease. It would not have helped anyway: the two steps it
  could have done (country-name normalisation, reshaping tables) are a fixed 35-entry map and a
  deterministic bracket walk, both in committed code and both cheaper to verify than to prompt.
  Nothing on this branch was written or checked by it.
* **Nothing was denied.** No action in this run was refused by the safety classifier. The only
  blocked avenues were external: the matchscorerlive widget 404s and the padel-magazine 504.
* No stream was running on this machine at any point (checked at the start and at 23:20).
* `padel.db` was never read — the archive draws are in this repo, so the laptop was not touched.
* `public/data/matches.json` and `rankings.json` were copied from padelticker.com into the
  worktree for local testing. Both are gitignored and were never staged.

---

## 8. The matches behind the placings — branch `national-teams-matches`, 2026-09-26

Kim's ask: *more matches from the country-vs-country events.* Nothing needed fetching. The
draws the bracket walk reads are already in this repo, and it was **throwing every match away**
after using it to work out a position. This branch keeps them.

`scripts/build-national-teams.mjs` now writes a second file,
**`public/data/national-teams-matches.json`** — 855 nation-vs-nation rubbers, 284 ties,
814 players, 37 nations, from the same four archived draws:

| edition | matches | ties | notes |
|---|---|---|---|
| `fip-135412` World 2024 | 261 | 96 | 2 rubbers dropped — a side was not one single nation |
| `fip-296741` Junior Euro Cup 2026 | 284 | 91 | 2 tie groups merged (same pair, same label, twice) |
| `fip-296740` Junior Africa Cup 2026 | 23 | 8 | |
| `fip-137970` **European 2024** | 287 | 89 | **no placing derivable, every match readable** |

**The one that matters is Cagliari.** Its 287 ties carry no round label, which blocks the
bracket walk and blocks nothing else — a rubber states its own result. So the edition that has
been a bare gap since 2026-09-15 now publishes all 287 of its matches, and Croatia and Monaco,
whose only appearance it is, get real pages instead of "no sourced placing".

Decisions worth keeping:

* **The matches pass refuses per ROW, the placings pass per EVENT.** A rubber whose side is not
  one single nation is dropped and counted; the edition still publishes. A placing still has to
  satisfy every structural check or the whole edition emits nothing.
* **A tie is aggregated only where the grouping is unambiguous.** Without a round label two
  meetings of the same pair collapse onto one key, which shows up as a rubber count above
  `TIE_RUBBERS`; those stay rubbers and are counted as `merged`, never published as one tie with
  an invented score.
* **The gaps now carry `matches` and `nations`**, so the hub can say "its 287 matches are
  published even so" and link those nations without loading the big file.
* **No name joins.** Players print exactly as the draw abbreviates them and are *not* linked to
  profiles. "P. Hansen" → a player id is a name join, and a wrong one puts the wrong person in a
  national team. That link is the obvious next step and needs its own verification.
* **The score is turned around on a nation's page.** It is stored in the draw's side order and a
  nation is side `b` in about half its matches — printed unflipped it reads "4-6 1-6" beside a
  **W**, which is exactly what the first cut of this branch did.

**Cross-check:** 52 of the 54 placings name the tie that settled them, and all 52 agree with the
ties derived independently in the matches pass — same opponent, same rubber score, same winner.
The other two are "group ties won, no placement match" rows, which name no tie. Every tie's
rubber count also equals the number of matches carrying it.

`scripts/test-national-teams.mjs` is up from 43 checks to **63, all passing**, including the
score orientation, Croatia's page, and the hub link that makes it reachable. `rankings.json`
must be in `public/data/` for a full green run (gitignored — `curl` it from padelticker.com);
without it the Denmark ranking check fails on any non-laptop checkout, on `main` too. That is a
fixture gap, not a regression.

**Not done, deliberately:** the hub tables are untouched, only the country pages and the gap
cards changed, and nothing new loads on the hub — the 188 KB match file is fetched lazily, on a
country page only.

To ship, §6 applies unchanged; the new `public/data/national-teams-matches.json` is tracked, so
the fast-forward carries it.
