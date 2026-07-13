// POST /api/unsubscribe  { endpoint }  — remove a Web Push subscription.
const json = (d, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!body || !body.endpoint) return json({ error: "no endpoint" }, 400);
  try {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(body.endpoint).run();
  } catch {}
  return json({ ok: true });
}
