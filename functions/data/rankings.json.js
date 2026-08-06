// GET /data/rankings.json — national rankings (RankedIn). freshest producer wins.
import { serveBlob } from "./_serve.js";
export const onRequestGet = (ctx) => serveBlob(ctx, "rankings.json");
