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

const teamsLine = (m) => m.teams.map((t) => t.name).join(" vs ");

function livePayload(matched) {
  const title = matched.length === 1 ? `🔴 Live: ${teamsLine(matched[0])}` : `🔴 ${matched.length} of your follows are live`;
  const body = matched.length === 1
    ? [matched[0].tournament?.name, matched[0].round].filter(Boolean).join(" · ")
    : matched.slice(0, 5).map(teamsLine).join("\n");
  return JSON.stringify({ title, body, url: "https://padelticker.com/" });
}

function soonPayload(matched) {
  const when = (m) => (m.estStart ? "~" + m.estStart : "soon");
  const title = matched.length === 1 ? `⏱ Starting soon: ${teamsLine(matched[0])}` : `⏱ ${matched.length} of your follows start soon`;
  const body = matched.length === 1
    ? [matched[0].tournament?.name, matched[0].court, when(matched[0])].filter(Boolean).join(" · ")
    : matched.slice(0, 5).map((m) => `${teamsLine(m)} (${when(m)})`).join("\n");
  return JSON.stringify({ title, body, url: "https://padelticker.com/" });
}

// Shared fan-out: for each subscription, send one push covering the matches that
// involve its follows. Prunes dead endpoints (410/404).
async function fanOut(matches, buildPayload, log, label) {
  if (!process.env.VAPID_PRIVATE_KEY || !matches || !matches.length) return;
  const subs = readSubs();
  if (subs === null) { log(`   ${label}: could not read subscriptions (D1)`); return; }
  if (!subs.length) return;

  webpush.setVapidDetails(SUBJECT, PUBLIC, process.env.VAPID_PRIVATE_KEY);
  let sent = 0, pruned = 0;
  for (const s of subs) {
    let follows;
    try { follows = JSON.parse(s.follows || "{}"); } catch { follows = {}; }
    const matched = matches.filter((m) => matchInvolves(m, follows));
    if (!matched.length) continue;
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, buildPayload(matched));
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        try { d1(`DELETE FROM push_subscriptions WHERE endpoint='${s.endpoint.replace(/'/g, "''")}'`); pruned++; } catch {}
      } else {
        log(`   ${label} send failed (${e.statusCode || "?"})`);
      }
    }
  }
  log(`🔔 ${label}: ${sent} subscriber(s) notified${pruned ? `, ${pruned} pruned` : ""}`);
}

export const sendLivePush = (matches, { log = () => {} } = {}) => fanOut(matches, livePayload, log, "push(live)");
export const sendStartingSoonPush = (matches, { log = () => {} } = {}) => fanOut(matches, soonPayload, log, "push(soon)");
