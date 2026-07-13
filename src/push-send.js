// Phase B: fan out Web Push when a followed player/tournament goes live.
// Runs in the refresh job (Node). Given the matches that JUST went live, match
// each stored subscription's follow set and send that subscriber one push.
// Sending uses the mature web-push lib; subscriptions are read from D1 via wrangler.
import webpush from "web-push";
import { execFileSync } from "node:child_process";

const PUBLIC = process.env.VAPID_PUBLIC_KEY || "BPQSyr1X8qC5cQcjaPud1Rgu9Dv9fMN81DAo8dJtAd4NHFwR-bCMViuw0z68rGBjFbkuPGFPRblIbsuNx5HlU48";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:danskepadelklip@gmail.com";

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

// same best-effort matching as the frontend favorites board: tournaments exact
// by source:id key, players by surname appearing in a team name (names differ in
// format across sources). follows = { players:{key:{name}}, tournaments:{key:{name}} }
const surnameOf = (n) => (n || "").trim().split(/\s+/).pop().toLowerCase();
export function matchInvolves(m, follows) {
  const tkeys = follows.tournaments || {};
  if (tkeys[m.source + ":" + m.tournament.id]) return true;
  const players = Object.values(follows.players || {});
  return players.some((p) => {
    const s = surnameOf(p.name);
    return s.length >= 3 && m.teams.some((t) => (t.name || "").toLowerCase().includes(s));
  });
}

function payloadFor(matched) {
  const line = (m) => m.teams.map((t) => t.name).join(" vs ");
  const title = matched.length === 1 ? `🔴 Live: ${line(matched[0])}` : `🔴 ${matched.length} of your follows are live`;
  const body = matched.length === 1
    ? [matched[0].tournament?.name, matched[0].round].filter(Boolean).join(" · ")
    : matched.slice(0, 5).map(line).join("\n");
  return JSON.stringify({ title, body, url: "https://padelticker.com/" });
}

export async function sendLivePush(newlyLiveMatches, { log = () => {} } = {}) {
  if (!process.env.VAPID_PRIVATE_KEY) return;
  if (!newlyLiveMatches || !newlyLiveMatches.length) return;
  const subs = readSubs();
  if (subs === null) { log("   push: could not read subscriptions (D1)"); return; }
  if (!subs.length) { log("   push: no subscriptions"); return; }

  webpush.setVapidDetails(SUBJECT, PUBLIC, process.env.VAPID_PRIVATE_KEY);
  let sent = 0, pruned = 0;
  for (const s of subs) {
    let follows;
    try { follows = JSON.parse(s.follows || "{}"); } catch { follows = {}; }
    const matched = newlyLiveMatches.filter((m) => matchInvolves(m, follows));
    if (!matched.length) continue;
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payloadFor(matched));
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        try { d1(`DELETE FROM push_subscriptions WHERE endpoint='${s.endpoint.replace(/'/g, "''")}'`); pruned++; } catch {}
      } else {
        log(`   push send failed (${e.statusCode || "?"})`);
      }
    }
  }
  log(`🔔 push: ${sent} subscriber(s) notified${pruned ? `, ${pruned} pruned` : ""}`);
}
