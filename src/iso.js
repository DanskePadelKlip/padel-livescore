// Country-code normalisation for RankedIn-sourced feeds — used by the live match
// adapter and by the national rankings builder, which read the same CountryShort
// field from the same API and had the same bug independently.
//
// RankedIn's CountryShort is NOT always a country. It returns the sentinel "rin"
// when a player has no country on file (1,769 of ~3,000 player slots in the live
// match feed on 2026-08-27) and ISO 3166-2 subdivisions like "gb-eng". Neither is
// ours to invent a value for, but neither may be passed through either: the client
// maps any two-letter code straight to regional-indicator glyphs, so a bogus one
// renders a WRONG flag, which is worse than no flag. Hence an allowlist rather than
// a shape check — the next sentinel may well be two letters.
//
// Sibling of iso2() in adapters/sporteaser.js, which solves the adjacent problem of
// mapping country NAMES to codes.

export const ISO_A2 = new Set((
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
  "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
  "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
  "HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY " +
  "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ OM " +
  "PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
  "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
  "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW " +
  // XK (Kosovo) is user-assigned, NOT officially in ISO 3166-1 — but it is the
  // de-facto code, app.js already maps it to a flag, and the national rankings
  // carried 170 xk rows on 2026-08-27. Omitting it would silently strip a real
  // nationality, which is the exact failure this guard exists to prevent.
  "XK"
).split(" "));

// A GB subdivision is real information about a real person — fold it to GB rather
// than discard it. ("gb-eng" was 11 player slots on 2026-08-27.)
export function iso2(code) {
  const c = String(code || "").trim().toUpperCase();
  if (ISO_A2.has(c)) return c;
  const sub = /^([A-Z]{2})-[A-Z0-9]{1,3}$/.exec(c);
  return sub && ISO_A2.has(sub[1]) ? sub[1] : null;
}
