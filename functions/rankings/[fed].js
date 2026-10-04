// GET /rankings/<fed> — a federation with no category segment.
//
// applyRoute() accepts it (seg[2] is optional) and the page renders, but only
// /rankings/<fed>/<cat> had a Function, so the one-segment form fell through to the
// app shell and its homepage canonical. It is a filtered view of the hub rather than
// its own page — the category pages are what the sitemap lists — so it canonicalises
// to /rankings, exactly as the national-teams slices do.
import { hub } from "../_hubs.js";

export const onRequestGet = hub("rankings");
