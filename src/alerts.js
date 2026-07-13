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

function line(m) {
  const teams = m.teams.map((t) => t.name).join("  vs  ");
  const where = [m.tournament?.name, m.round, m.court].filter(Boolean).join(" · ");
  return `${FLAGS[m.federation] || "🎾"} 🔴 **LIVE** — ${teams}\n${where}`;
}

export async function sendAlerts(matches, webhookUrl, { max = 8 } = {}) {
  if (!webhookUrl || !matches.length) return 0;
  const body =
    `🎾 **PadelTicker — now live** (${matches.length})\n\n` +
    matches.slice(0, max).map(line).join("\n\n") +
    (matches.length > max ? `\n\n…and ${matches.length - max} more` : "") +
    `\n\nhttps://padelticker.com`;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: body, text: body }), // content=Discord, text=Slack
    });
    return res.ok ? matches.length : 0;
  } catch {
    return 0;
  }
}
