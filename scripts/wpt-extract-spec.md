# WPT 2019 round-result extraction spec

You extract padel match results from **French** news articles into structured JSON.

## Input
`scratch/wpt-rounds-2019.raw.json` — `{ tournaments: [ { key, name, city, start, articles: [ { date, title, text } ] } ] }`.
You are assigned a list of **cities**. Process only tournaments whose `city` is in your list.

## What to extract
Every **completed match with a score** mentioned in the articles for your tournaments. Ignore
previews ("aura lieu", "ce soir"), interviews, ranking/points talk, and matches with no score.

French → round mapping (`round` field, use these exact English values):
- `finale` → **Final**
- `demi-finale` / `demi-finales` / `1/2` → **Semifinal**
- `quart de finale` / `quarts` / `1/4` → **Quarterfinal**
- `huitièmes` / `1/8` / `8es` → **Round of 16**
- `seizièmes` / `1/16` / `16es` → **Round of 32**
- qualifying / `qualifs` / `qualy` / `pré-qualif` → **Qualifying**
- if a round is clearly stated some other way, use your best English label; if truly unknown → `null`

`gender`: **Men** or **Women** (French: masculin/messieurs/hommes → Men; féminin/dames/femmes → Women).
Infer from context/player names if not explicit. If genuinely unsure → `null`.

Players: a pair is two people ("X et Y", "X/Y", "X - Y"). Split into two names, keep full names as written
(keep accents). Winner = the pair that won ("s'impose(nt)", "bat", "battent", "dominent", "remporte(nt)",
"élimine(nt)", "se qualifie(nt)"); loser = the other pair ("s'inclinent", "chutent", "face à").

Scores: normalise to space-separated sets with a hyphen, e.g. `6/4 6/2` → `"6-4 6-2"`; `4-6, 6-1, 6-3`
→ `"4-6 6-1 6-3"`; keep tie-break digits if written (`7/6(5)` → `"7-6(5)"`). Retirement/walkover: append
` ab.` or ` wo` and still record the pairs. If no clean score → skip the match.

## Output
Append this session's results to `scratch/wpt-rounds-2019.part-<N>.json` (N given to you) as a JSON array of:
```
{ "key": "<tournament key from the raw file>", "gender": "Men|Women|null",
  "round": "Final|Semifinal|Quarterfinal|Round of 16|Round of 32|Qualifying|null",
  "winners": ["Name A","Name B"], "losers": ["Name C","Name D"], "score": "6-4 6-2",
  "confidence": "high|medium|low" }
```
- **De-dup within your set**: the same match is often described in several articles — emit it ONCE
  (highest-confidence version). Semifinals + finals are frequently repeated; keep one.
- `confidence`: high = pairing + score + round all explicit; medium = one inferred; low = shaky.
- Write ONLY the JSON array to the file (valid JSON, no prose). If you extract nothing, write `[]`.

Accuracy over volume — a wrong result is worse than a missing one. When a sentence is ambiguous about
who won or the exact score, drop it rather than guess.
