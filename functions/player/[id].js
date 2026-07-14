// GET /player/:id — app shell with this player's meta injected for scrapers.
import { SITE, shell, withMeta } from "../_shared.js";

export async function onRequestGet({ request, params }) {
  const origin = new URL(request.url).origin;
  const id = params.id;
  const base = await shell(origin);

  let d = null;
  try {
    const r = await fetch(origin + "/api/player/" + encodeURIComponent(id));
    if (r.ok) d = await r.json();
  } catch {}
  if (!d || !d.player) return base; // unknown id → generic shell (SPA still works)

  const p = d.player;
  const s = d.summary || {};
  const cc = p.country ? String(p.country).toUpperCase() : "";
  const wl = s.total ? `${s.wins}–${s.losses}` : null;         // en-dash
  const pct = s.total ? Math.round((s.wins / s.total) * 100) : null;

  const bits = [];
  if (cc) bits.push(cc);
  if (s.total) bits.push(`${s.total} matches`);
  if (wl) bits.push(`${wl} W–L`);
  if (pct != null) bits.push(`${pct}% win rate`);

  const title = `${p.name} — padel results, ranking & head-to-head · PadelTicker`;
  const description =
    `${p.name}${bits.length ? " — " + bits.join(" · ") : ""}. ` +
    `Full padel match history, results and head-to-head on PadelTicker.`;
  const canonical = `${SITE}/player/${encodeURIComponent(id)}`;

  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: p.name,
    url: canonical,
    jobTitle: "Padel player",
    ...(cc ? { nationality: cc } : {}),
  };

  const image = `${SITE}/og/player/${encodeURIComponent(id)}`;
  return withMeta(base, { title, description, canonical, ogType: "profile", image, jsonld });
}
