// GET /national-teams - app shell with this section's own meta (see _hubs.js for why).
//
// This route was a 301 to danskepadelklip.com/landshold between 2026-09-10 and this
// commit. That was right while the page held DENMARK's results and nothing else -
// a one-nation table does not belong on an international scores site, and DPK
// already carried the identical rows. The section here now covers every nation in
// each championship, which DPK's page does not and should not, so the redirect goes
// and the hub comes back. Denmark's own table stays on DPK; nothing here duplicates
// it. NB the old redirect only ever answered GET, so a HEAD request has been
// getting the app shell at 200 throughout.
import { hub } from "./_hubs.js";

export const onRequestGet = hub("national-teams");
