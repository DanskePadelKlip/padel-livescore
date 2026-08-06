// GET /data/matches.json — the live feed. freshest of D1 (fallback worker) and static
// (daemon deploy), empty-but-valid shape if neither exists yet.
import { serveBlob } from "./_serve.js";
export const onRequestGet = (ctx) =>
  serveBlob(ctx, "matches.json", { emptyFallback: { generatedAt: null, date: null, count: 0, matches: [] } });
