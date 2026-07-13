// National rankings from RankedIn's GetRankingsAsync — the differentiator vs
// pro-only sites (they only show the FIP world ranking; we show live NATIONAL
// rankings). Each row carries the RankedinId, which links straight to a player
// profile (Phase 2 D1). Output -> public/data/rankings.json.

import { rankedinGet, sleep } from "./http.js";

// federation -> RankedIn national ranking-list id. All share one global category
// taxonomy (see CATS) — verified 2026-07-13 via GetOrganisationRankingsAsync, so
// adding a nation is just one row here (+ a flag in public/app.js FLAGS).
const LISTS = [
  { fed: "DK", rankingId: 2032 },  // Dansk Padel Forbund
  { fed: "SE", rankingId: 1917 },  // Svenska Padelförbundet
  { fed: "DE", rankingId: 2617 },  // Deutscher Padel Verband
  { fed: "HR", rankingId: 1967 },  // Hrvatski Padel Savez
  { fed: "EE", rankingId: 2458 },  // Eesti Padeli Liit
  { fed: "GE", rankingId: 14332 }, // Georgian National Padel Federation
  { fed: "HU", rankingId: 2375 },  // MAPASZ — Magyar Padel Szövetség
  { fed: "UA", rankingId: 12010 }, // Padel Federation Ukraine (season race)
  { fed: "SI", rankingId: 11248 }, // Padel Zveza Slovenije
  { fed: "XK", rankingId: 11117 }, // Padel Kosova
  { fed: "BA", rankingId: 15514 }, // Padel liga Bosne i Hercegovine
  { fed: "ME", rankingId: 11004 }, // Padel Federation Montenegro (PFMNE)
];
// ageGroup/rankingType/gender for the two main categories (verified 2026-07-13)
const CATS = [
  { key: "men", label: "Men", ageGroup: 82, rankingType: 3, gender: 1 },
  { key: "women", label: "Women", ageGroup: 83, rankingType: 4, gender: 2 },
];

export async function fetchRankings({ take = 250, log = () => {} } = {}) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const wk = isoWeek(now); // NB: RankedIn ignores week/year and returns the current list
  const lists = [];
  for (const l of LISTS) {
    for (const c of CATS) {
      try {
        const d = await rankedinGet(
          `ranking/GetRankingsAsync?rankingId=${l.rankingId}&ageGroup=${c.ageGroup}&rankingType=${c.rankingType}&week=${wk}&year=${y}&participantGender=${c.gender}&skip=0&take=${take}`
        );
        const rows = (d.Payload || []).map((r) => ({
          rank: r.Standing,
          name: r.Name,
          country: r.CountryShort,
          points: r.ParticipantPoints?.Points ?? null,
          club: r.HomeClubName || null,
          id: r.RankedinId || null,
        }));
        lists.push({ fed: l.fed, category: c.key, label: c.label, total: d.TotalCount || rows.length, rows });
        log(`  rankings ${l.fed} ${c.label}: ${rows.length}/${d.TotalCount}`);
        await sleep(150);
      } catch (e) {
        log(`  rankings ${l.fed} ${c.label} failed — ${e.message}`);
      }
    }
  }
  return lists;
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - ys) / 86400000 + 1) / 7);
}
