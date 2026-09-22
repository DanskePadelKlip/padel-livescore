// GET /national-teams/<gender>/<category> - the section's filter slices.
//
// Without this they fell through to the app shell, whose canonical is the homepage:
// Google would be told "index this" and "this is really the homepage" at once, which
// is what dropped the hub pages in 2026-07 (see _hubs.js). hub() canonicalises every
// slice back to /national-teams, which is the honest answer - they are the same rows
// filtered, not separate pages - so only /national-teams is in the sitemap.
import { hub } from "../_hubs.js";

export const onRequestGet = hub("national-teams");
