// POST /api/subscribe
// body: { subscription: {endpoint, keys:{p256dh,auth}}, follows: {players,tournaments} }
// Upserts the Web Push subscription + the user's follow set into D1.
const json = (d, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });

async function ensureTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
       endpoint   TEXT PRIMARY KEY,
       p256dh     TEXT NOT NULL,
       auth       TEXT NOT NULL,
       follows    TEXT,
       created_at TEXT,
       updated_at TEXT
     )`
  ).run();
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const sub = body && body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
    return json({ error: "invalid subscription" }, 400);

  await ensureTable(env);
  const follows = JSON.stringify(body.follows || {});
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, follows, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = ?2, auth = ?3, follows = ?4, updated_at = datetime('now')`
  ).bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth, follows).run();

  return json({ ok: true });
}
