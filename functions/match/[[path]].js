// GET /match/:source/:tournamentId/:round/:pair — app shell with this match's meta
// injected. Social scrapers don't run the SPA, so without this a shared match link
// previews as the generic homepage card (see _shared.js).
import { SITE, shell, withMeta } from "../_shared.js";
import { findMatch, parseMatchPath, matchLabel, teamLabel, scoreLabel } from "../_matchkey.js";

export async function onRequestGet({ request, params }) {
  const origin = new URL(request.url).origin;
  const base = await shell(origin);

  const q = parseMatchPath(params.path || []);
  if (!q) return base;

  const found = await findMatch(origin, q);
  if (!found) return base; // unknown match → generic shell, and the SPA falls back to the draw
  const { match: m, tournament: t } = found;

  const pair = matchLabel(m);
  const score = scoreLabel(m);
  const round = m.round || "";
  const won = m.score && m.score.winner != null ? teamLabel(m.teams[m.score.winner]) : null;

  const title = `${pair}${t.name ? ` — ${t.name}` : ""} · PadelTicker`;
  const description = m.status === "final" && score
    ? `${pair}: ${score}${won ? ` — ${won} won` : ""}${round ? `, ${round}` : ""}${t.name ? ` at ${t.name}` : ""}.`
    : `${pair}${round ? ` — ${round}` : ""}${t.name ? ` at ${t.name}` : ""}. Live score, sets and head-to-head on PadelTicker.`;

  const path = `/match/${encodeURIComponent(q.source)}/${encodeURIComponent(q.id)}/${q.round}/${q.pair}`;
  const canonical = SITE + path;
  const image = SITE + "/og" + path;

  const jsonld = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: `${pair}${round ? ` — ${round}` : ""}`,
    sport: "Padel",
    url: canonical,
    description,
    image,
    ...(t.name ? { superEvent: { "@type": "SportsEvent", name: t.name, sport: "Padel" } } : {}),
    competitor: m.teams.map((x) => ({ "@type": "SportsTeam", name: teamLabel(x) })),
    // schema.org has no "finished" SportsEvent status, so this is the only honest
    // value for either state; the score in `description` carries the rest.
    eventStatus: "https://schema.org/EventScheduled",
  };

  return withMeta(base, { title, description, canonical, ogType: "article", image, jsonld });
}
