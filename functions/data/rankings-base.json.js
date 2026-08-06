// GET /data/rankings-base.json — weekly movement baseline, consumed only by the
// refresh pipelines (src/rank-movement.js). No generatedAt to compare, so:
// worker's D1 copy first, static asset fallback.
import { serveBlob } from "./_serve.js";
export const onRequestGet = (ctx) => serveBlob(ctx, "rankings-base.json", { d1First: true });
