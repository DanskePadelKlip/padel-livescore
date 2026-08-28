// Shared upstream constants for the two FIP live-detail providers.
//
// Extracted from the adapters so that BOTH the Node refresh path and the edge
// (functions/api/live-detail.js, which cannot pull in linkedom) address the same
// endpoints with the same headers. The values are byte-identical to the ones the
// adapters carried inline before — this module moved them, it did not change them.
//
// Both upstreams 403 without a browser User-Agent AND a padelfip Referer.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/** Crionet / matchscorerlive widget (server-rendered HTML). */
export const FIP_HEADERS = {
  "User-Agent": UA,
  Referer: "https://www.padelfip.com/",
  Accept: "text/html,application/json",
};

/** Sporteaser public JSON API + padelfip's own admin-ajax. */
export const SPORTEASER_HEADERS = {
  "User-Agent": UA,
  Referer: "https://www.padelfip.com/",
  Accept: "application/json, text/html",
};

export const WIDGET = "https://widget.matchscorerlive.com/screen";
export const LIVE_BOARD = `${WIDGET}/tournamentlive`;
export const SPORTEASER_API = "https://v0.sporteaser.app/api/public";
export const PADELFIP_AJAX = "https://www.padelfip.com/wp-admin/admin-ajax.php";

/** One day of a sporteaser tournament. `day` is a DAY-OF-MONTH, not an ordinal. */
export const sporteaserDayUrl = (tid, day) =>
  `${SPORTEASER_API}/tournament/${tid}/matches/day/${day}/sort/fieldname/0`;

/** Crionet's live board for one event ("FIP-2026-3507"). Only ever lists on-court matches. */
export const liveBoardUrl = (msId) => `${LIVE_BOARD}/${msId}?t=tol`;

/** Crionet order-of-play for one play-day of one event. */
export const oopUrl = (msId, day) => `${WIDGET}/oopbyday/${msId}/${day}?t=tol`;
