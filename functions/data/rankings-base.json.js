// GET /data/rankings-base.json — weekly movement baseline. Only the Node refresh
// pipeline reads this (src/rank-movement.js); served so both producers share it.
import { serveBlob } from "./_serve.js";
export const onRequestGet = (ctx) => serveBlob(ctx, "rankings-base.json");
