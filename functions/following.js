// GET /following — the viewer's own starred players and tournaments.
//
// It needs a Function for the same reason the hubs do: without one it fell through to
// the raw app shell, which canonicalises to the homepage. But unlike a hub this page
// has no shared content — it renders whatever is in THIS visitor's localStorage — so
// it is served noindex rather than given a self-canonical. The route must still exist
// and return 200, because public/404.html now makes an unmatched path a real 404.
import { shell, withMeta, SITE } from "./_shared.js";

export async function onRequestGet({ request }) {
  const origin = new URL(request.url).origin;
  const base = await shell(origin);
  const res = withMeta(base, {
    title: "Following · PadelTicker",
    description: "The players and tournaments you follow on PadelTicker.",
    canonical: `${SITE}/following`,
    ogType: "website",
  });
  res.headers.set("x-robots-tag", "noindex, follow");
  return res;
}
