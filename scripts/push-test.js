// Phase A proof: send a test Web Push to every stored subscription.
// Reads subscriptions from D1 via wrangler (remote), then sends with web-push
// (the mature Node library handles VAPID signing + payload encryption).
//
// Env: VAPID_PRIVATE_KEY (secret), optional VAPID_PUBLIC_KEY / VAPID_SUBJECT,
//      CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (for wrangler --remote).
import webpush from "web-push";
import { execFileSync } from "node:child_process";

const PUBLIC = process.env.VAPID_PUBLIC_KEY || "BPQSyr1X8qC5cQcjaPud1Rgu9Dv9fMN81DAo8dJtAd4NHFwR-bCMViuw0z68rGBjFbkuPGFPRblIbsuNx5HlU48";
const PRIVATE = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:danskepadelklip@gmail.com";
if (!PRIVATE) { console.error("Missing VAPID_PRIVATE_KEY"); process.exit(1); }
webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const d1 = (sql) =>
  execFileSync(npx, ["--yes", "wrangler@4", "d1", "execute", "padelticker-history", "--remote", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

function rows() {
  const out = JSON.parse(d1("SELECT endpoint,p256dh,auth FROM push_subscriptions"));
  return (Array.isArray(out) ? out[0]?.results : out?.result?.[0]?.results) || [];
}

const subs = rows();
console.log(`Sending test push to ${subs.length} subscription(s)…`);
const payload = JSON.stringify({
  title: "PadelTicker ✅",
  body: "Push is working — you'll get pinged when a followed player or tournament goes live.",
  tag: "pt-test",
  url: "https://padelticker.com/",
});

let ok = 0, pruned = 0, failed = 0;
for (const r of subs) {
  const sub = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
  try {
    await webpush.sendNotification(sub, payload);
    ok++;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      d1(`DELETE FROM push_subscriptions WHERE endpoint='${r.endpoint.replace(/'/g, "''")}'`);
      pruned++;
    } else {
      failed++;
      console.error(`  send failed (${e.statusCode || "?"}):`, e.body || e.message);
    }
  }
}
console.log(`Done — ${ok} sent, ${pruned} pruned (expired), ${failed} failed.`);
