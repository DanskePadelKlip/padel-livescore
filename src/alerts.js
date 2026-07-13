// Alerts v1 — a "now live" feed. Given the previous published matches and the
// fresh ones, find matches that JUST transitioned to live and POST them to a
// webhook (Discord-compatible; Slack works too via `text`). Wired into the fetch
// job; fires only when process.env.ALERT_WEBHOOK_URL is set.

const FLAGS = { FIP: "🌍", DK: "🇩🇰", SE: "🇸🇪", DE: "🇩🇪", CZ: "🇨🇿", NO: "🇳🇴", FI: "🇫🇮", FR: "🇫🇷" };

// matches that are live now but were NOT live in the previous snapshot
export function newlyLive(prev, next) {
  const wasLive = new Set((prev || []).filter((m) => m.status === "live").map((m) => m.id));
  return (next || []).filter((m) => m.status === "live" && !wasLive.has(m.id));
}

// Upcoming matches (FIP, est-timed) that have newly entered the "starts within
// leadMs" window since the previous snapshot — so a "starting soon" pre-alert
// fires once, ~lead minutes before the estimated start. `prevAt`/`nextAt` are the
// reference times (ms) the two snapshots were generated.
const withinLead = (iso, at, leadMs) => { const d = new Date(iso).getTime() - at; return d > 0 && d <= leadMs; };
export function newlySoon(prevMatches, prevAt, nextMatches, nextAt, leadMs) {
  const wasSoon = new Set(
    (prevMatches || []).filter((m) => m.status === "upcoming" && m.estStartAt && withinLead(m.estStartAt, prevAt, leadMs)).map((m) => m.id)
  );
  return (nextMatches || []).filter(
    (m) => m.status === "upcoming" && m.estStartAt && withinLead(m.estStartAt, nextAt, leadMs) && !wasSoon.has(m.id)
  );
}

const teamsOf = (m) => m.teams.map((t) => t.name).join("  vs  ");

function liveLine(m) {
  const where = [m.tournament?.name, m.round, m.court].filter(Boolean).join(" · ");
  return `${FLAGS[m.federation] || "🎾"} 🔴 **LIVE** — ${teamsOf(m)}\n${where}`;
}
function soonLine(m) {
  const when = m.estStart ? `~${m.estStart}` : "soon";
  const where = [m.court, m.round, m.tournament?.name].filter(Boolean).join(" · ");
  return `${FLAGS[m.federation] || "🎾"} ⏱ **SOON** (${when}) — ${teamsOf(m)}\n${where}`;
}

async function post(webhookUrl, body) {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: body, text: body }), // content=Discord, text=Slack
    });
    return res.ok;
  } catch {
    return false;
  }
}

function digest(heading, matches, fmt, max) {
  return `🎾 **PadelTicker — ${heading}** (${matches.length})\n\n` +
    matches.slice(0, max).map(fmt).join("\n\n") +
    (matches.length > max ? `\n\n…and ${matches.length - max} more` : "") +
    `\n\nhttps://padelticker.com`;
}

export async function sendAlerts(matches, webhookUrl, { max = 8 } = {}) {
  if (!webhookUrl || !matches.length) return 0;
  return (await post(webhookUrl, digest("now live", matches, liveLine, max))) ? matches.length : 0;
}

export async function sendSoonAlerts(matches, webhookUrl, { max = 8 } = {}) {
  if (!webhookUrl || !matches.length) return 0;
  return (await post(webhookUrl, digest("starting soon", matches, soonLine, max))) ? matches.length : 0;
}
