// Web Push fan-out logic shared by BOTH senders — the Node refresh job
// (src/push-send.js, web-push lib + wrangler-CLI D1) and the scheduled Worker
// (worker/index.js, WebCrypto + native D1 binding). Everything here is pure:
// which subscriptions a set of matches concerns, and what the notification says.
// Keep it that way, or the two senders drift and subscribers get different
// notifications depending on which pipeline caught the transition.

export const VAPID_PUBLIC_KEY =
  "BPQSyr1X8qC5cQcjaPud1Rgu9Dv9fMN81DAo8dJtAd4NHFwR-bCMViuw0z68rGBjFbkuPGFPRblIbsuNx5HlU48";
export const VAPID_SUBJECT = "mailto:danskepadelklip@gmail.com";

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

export function livePayload(matched) {
  const title = matched.length === 1 ? `🔴 Live: ${teamsLine(matched[0])}` : `🔴 ${matched.length} of your follows are live`;
  const body = matched.length === 1
    ? [matched[0].tournament?.name, matched[0].round].filter(Boolean).join(" · ")
    : matched.slice(0, 5).map(teamsLine).join("\n");
  return JSON.stringify({ title, body, url: "https://padelticker.com/" });
}

export function soonPayload(matched) {
  const when = (m) => (m.estStart ? "~" + m.estStart : "soon");
  const title = matched.length === 1 ? `⏱ Starting soon: ${teamsLine(matched[0])}` : `⏱ ${matched.length} of your follows start soon`;
  const body = matched.length === 1
    ? [matched[0].tournament?.name, matched[0].court, when(matched[0])].filter(Boolean).join(" · ")
    : matched.slice(0, 5).map((m) => `${teamsLine(m)} (${when(m)})`).join("\n");
  return JSON.stringify({ title, body, url: "https://padelticker.com/" });
}

// Shared fan-out shape: for each subscription, send ONE push covering the matches
// that involve its follows. `send(sub, payload)` is the transport; it must throw
// an error with a `statusCode` on HTTP failure. `prune(endpoint)` removes a dead
// subscription (410/404). Returns {sent, pruned}.
export async function fanOut(matches, subs, buildPayload, send, prune, log, label) {
  let sent = 0, pruned = 0;
  for (const s of subs) {
    let follows;
    try { follows = JSON.parse(s.follows || "{}"); } catch { follows = {}; }
    const matched = matches.filter((m) => matchInvolves(m, follows));
    if (!matched.length) continue;
    try {
      await send(s, buildPayload(matched));
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        try { await prune(s.endpoint); pruned++; } catch {}
      } else {
        log(`   ${label} send failed (${e.statusCode || "?"})`);
      }
    }
  }
  log(`🔔 ${label}: ${sent} subscriber(s) notified${pruned ? `, ${pruned} pruned` : ""}`);
  return { sent, pruned };
}
