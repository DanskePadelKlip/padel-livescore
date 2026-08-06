// GET /data/health.json — raw pipeline facts for /api/health. freshest producer wins; a 404
// when neither producer has written yet is CORRECT (health derives "down").
import { serveBlob } from "./_serve.js";
export const onRequestGet = (ctx) => serveBlob(ctx, "health.json");
