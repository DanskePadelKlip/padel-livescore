// RankedIn federations to pull. VERIFIED org-agnostic on 2026-07-12: the same
// endpoints return identical schemas for each org — only the org id changes.
// One adapter, many countries. Add a row to cover a new federation.
//
// `org` is the RankedIn organisationId (used for event discovery + matches).
// `ranking` (optional) is the national ranking-list id — only needed for the
// rankings feature later, NOT for livescore. Left null where not yet looked up.

export const RANKEDIN_FEDERATIONS = [
  { code: "DK", name: "Dansk Padel Forbund",       org: 1420, ranking: 2032 },
  { code: "SE", name: "Svenska Padelförbundet",    org: 1340, ranking: 1917 },
  { code: "DE", name: "Deutscher Padel Verband",   org: 1883, ranking: 2617 },
  { code: "CZ", name: "Czech Padel Federation",    org: 9531, ranking: null },
];
// National RANKINGS also cover federations that don't host events centrally
// (so they're not in RANKEDIN_FEDERATIONS above). Ranking-list ids, verified
// 2026-07-13 via GetOrganisationRankingsAsync — wired into src/rankings.js:
//   HR Hrvatski Padel Savez #1967, EE Eesti Padeli Liit #2458,
//   GE Georgian National Padel Federation #14332.
// Empty at the time (fed not maintaining a RankedIn ranking): CZ #14739,
// AT #4107, CH #4354/#14636, LV #5762.

// IMPORTANT (verified 2026-07-12): GetOrganisationEventsAsync only returns
// events for federations that host tournaments CENTRALLY under their national
// org (DK, SE, DE, CZ). "Decentralized" federations return totalCount 0 here
// because their clubs host under separate club orgs — the matches ARE on
// RankedIn, just not under the federation org. Confirmed empty at org level:
//   AT Austria (3022), EE Estonia (1763), CH Swiss (3445/10509), HR Croatia
//   (1375), LV Latvia (4528), GE Georgia (10295, last event 2025).
// To cover those we need a COUNTRY-LEVEL event-discovery endpoint (TODO) rather
// than another federation row.

// tournamentsoftware.com instances (JS/AJAX + cookiewall, scraped via Playwright).
// NORWAY runs padel here (norsktennis.no links to ntf). Verified 2026-07-12:
// real match data with per-set scores + live scoring. GB/LTA runs the SAME
// platform, white-labelled at competitions.lta.org.uk (was lta.tournamentsoftware.com)
// — covers the LTA Padel British/National Tour incl. Rocks Lane Grade 1.
// `base` is the instance host; `locale` selects the month-name language used to
// parse dates (the DOM markup is shared platform HTML, only the language differs).
export const TOURNAMENTSOFTWARE_INSTANCES = [
  { code: "NO", name: "Norges Tennis- og Padelforbund", base: "https://ntf.tournamentsoftware.com", locale: "no" },
  { code: "GB", name: "LTA (Lawn Tennis Association)",   base: "https://competitions.lta.org.uk",   locale: "en" },
  // Padel Australia — dedicated padel instance. Verified 2026-07-20: its Club Padel
  // Tour + Masters Series publish full scored matches (188 in one weekend event).
  // Tennis Ireland (ti.tournamentsoftware.com) was checked and REJECTED the same
  // day: its padel is club championships / summer leagues with no match grid — the
  // same empty-grid signature as LTA's non-tour club events. Only instances with a
  // real competitive TOUR yield match data; club/box-league bodies don't.
  { code: "AU", name: "Padel Australia",                 base: "https://pa.tournamentsoftware.com",  locale: "en" },
];

// NOT viable as livescore sources (verified 2026-07-12):
//   FI Finland (Padelution) — Laravel/Livewire, no API. Deeper problem: typical
//     Finnish events publish only final STANDINGS (/results); /matches + /draws are
//     empty, and there's no live-match feed. Nothing for a livescore to show.
//     Deferred until (if ever) larger events expose brackets worth bracket-scraping.
//   NO Norway is NOT here — it lives on tournamentsoftware (above), which works.
//   FR France (Ten'Up/FFT) — verified 2026-07-12 NOT viable: tenup.fft.fr is a
//     Nuxt SPA behind a queue-it waiting room; tournament pages show only
//     registration (épreuves/pricing), never draws or scores. Results are
//     referee-entered into players' LOGIN-GATED palmarès and only surface as the
//     monthly ranking — no public per-match scores, no live scoring. French PRO
//     padel (Premier/FIP events in France) is already covered by the fip adapter.
export const NON_RANKEDIN = [
  { code: "FI", name: "Suomen Padelliitto", platform: "padelution", reason: "standings-only, no match/live data" },
  { code: "FR", name: "FFT / Ten'Up", platform: "tenup", reason: "registration+rankings only, no public match scores; pro events covered via FIP" },
  // ES verified NOT viable 2026-07-20: padelfederacion.es is classic ASP. Reverse-
  // engineered the full path — list (irCamp id) -> Torneos_Previo.asp (POST idtorneo)
  // -> per-format page (Camp_Parejas_*, Campeonato.asp) -> genero GET -> "Cuadro
  // Final". The cuadros are bracket GRAPHICS/PDFs: ZERO per-match scores in the HTML
  // across both a team (Cto España Veteranos) and an individual (TyC Premium) format.
  // Same shape as FR: public championships + rankings, no public/scrapeable match
  // scores, no live scoring. Spanish PRO is covered via fip; the rich regional circuit
  // is only aggregated by elpadel.pro (Next.js + Clerk auth, a competitor — avoid:
  // violates own-your-lookups + ToS). So Spain beyond the pro tour is not addressable.
  { code: "ES", name: "FEP (Federación Española de Pádel)", platform: "padelfederacion.es", reason: "cuadros are bracket graphics/PDFs, no scrapeable match scores; pro via FIP; regional only on competitor aggregator elpadel.pro" },
];

// A1 Padel — DROPPED 2026-07-20. Was flagged blocked-but-viable (Latin-America pro
// tour with a live scoreboard worth an adapter), but A1 has been SUSPENDED —
// outcompeted by Premier Padel's consolidation of pro padel. Evidence: no "Torneos
// 2026" tab on a1padelglobal.com (only past years + an empty "Próximos Torneos"),
// dead scoreboard, no 2026 schedule anywhere. Not worth any build time. Pro padel is
// covered by fip (Premier + FIP). Do NOT re-investigate unless A1 visibly relaunches.
