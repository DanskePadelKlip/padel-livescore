// GET /data/matches.json — the live feed. KV-first (scheduled worker), static
// asset fallback, empty-but-valid shape if neither exists yet.
import { serveBlob } from "./_serve.js";
export const onRequestGet = (ctx) =>
  serveBlob(ctx, "matches.json", { emptyFallback: { generatedAt: null, date: null, count: 0, matches: [] } });
