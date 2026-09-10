// GET /national-teams - moved to danskepadelklip.com/landshold (removed from PadelTicker
// 2026-09-10). The page was Denmark's results only, and DPK already carries the same
// table, so it belongs there, not on an international scores site.
//
// A 301 rather than letting the SPA shell answer: without this function the route
// falls through to the app, which no longer knows it and quietly shows the homepage -
// an old link or search result should land on the real page instead.
export const onRequestGet = () => Response.redirect("https://danskepadelklip.com/landshold", 301);
