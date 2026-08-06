// GET /data/calendar.json — curated pro calendar. KV-first (worker refreshes it
// weekly from Wikipedia); the committed public/data/calendar.json is the fallback.
import { serveBlob } from "./_serve.js";
export const onRequestGet = (ctx) => serveBlob(ctx, "calendar.json");
