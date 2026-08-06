// Phase B, Node transport: fan out Web Push when a followed player/tournament
// goes live. Runs in the Node refresh jobs (fetch-live.js, refresh-loop.js).
// Matching + payloads live in src/push-core.js (shared with the Worker sender);
// this file only knows how to read D1 via the wrangler CLI and send via the
// mature web-push lib.
import webpush from "web-push";
import { execFileSync } from "node:child_process";
import { VAPID_PUBLIC_KEY, VAPID_SUBJECT, fanOut, livePayload, soonPayload } from "./push-core.js";

const PUBLIC = process.env.VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || VAPID_SUBJECT;

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const d1 = (sql) =>
  execFileSync(npx, ["--yes", "wrangler@4", "d1", "execute", "padelticker-history", "--remote", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

function readSubs() {
  try {
    const out = JSON.parse(d1("SELECT endpoint,p256dh,auth,follows FROM push_subscriptions"));
    return (Array.isArray(out) ? out[0]?.results : out?.result?.[0]?.results) || [];
  } catch { return null; }
}

async function run(matches, buildPayload, log, label) {
  if (!process.env.VAPID_PRIVATE_KEY || !matches || !matches.length) return;
  const subs = readSubs();
  if (subs === null) { log(`   ${label}: could not read subscriptions (D1)`); return; }
  if (!subs.length) return;

  webpush.setVapidDetails(SUBJECT, PUBLIC, process.env.VAPID_PRIVATE_KEY);
  await fanOut(
    matches, subs, buildPayload,
    (s, payload) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload),
    (endpoint) => d1(`DELETE FROM push_subscriptions WHERE endpoint='${endpoint.replace(/'/g, "''")}'`),
    log, label
  );
}

export const sendLivePush = (matches, { log = () => {} } = {}) => run(matches, livePayload, log, "push(live)");
export const sendStartingSoonPush = (matches, { log = () => {} } = {}) => run(matches, soonPayload, log, "push(soon)");
