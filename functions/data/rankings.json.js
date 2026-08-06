// GET /data/rankings.json — national rankings (RankedIn). KV-first.
import { serveBlob } from "./_serve.js";
export const onRequestGet = (ctx) => serveBlob(ctx, "rankings.json");
