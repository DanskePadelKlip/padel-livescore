// Shared renderer for dynamic Open Graph share images (SEO Phase 3).
//
// Builds a branded 1200×630 card as SVG and rasterises it to PNG at the edge
// with resvg (WASM). Rendered on demand and cached (Cache API + a 1-day TTL),
// so only entities that actually get shared are ever drawn, and only once.
// Fonts live as static assets (public/fonts) so they stay out of the Worker
// bundle. (Filenames starting with "_" are not turned into routes.)
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

// --- one-time init, shared across every OG request in this isolate -----------
let wasmReady = null;
function ensureWasm() {
  if (!wasmReady) {
    wasmReady = initWasm(resvgWasm).catch((e) => {
      if (String(e).includes("Already initialized")) return; // harmless double-init
      wasmReady = null;
      throw e;
    });
  }
  return wasmReady;
}

let fontsPromise = null;
function loadFonts(origin) {
  if (!fontsPromise) {
    const get = (f) => fetch(origin + "/fonts/" + f).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b));
    fontsPromise = Promise.all([get("Inter-Bold.ttf"), get("Inter-Regular.ttf")]);
  }
  return fontsPromise;
}

// --- card artwork ------------------------------------------------------------
const BG = "#0e1014", CARD = "#14171c", TEXT = "#f4f5f7", MUTED = "#9aa3ad", ACCENT = "#e5484a", LINE = "#262b32";

const xesc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s || "");

function frame(inner) {
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="${BG}"/>
  <rect width="14" height="630" fill="${ACCENT}"/>
  <circle cx="86" cy="78" r="13" fill="${ACCENT}"/>
  <text x="112" y="90" font-family="Inter" font-weight="700" font-size="38" fill="${TEXT}">PadelTicker</text>
  <text x="340" y="88" font-family="Inter" font-weight="400" font-size="22" letter-spacing="2" fill="${MUTED}">LIVE PADEL SCORES</text>
  <line x1="70" y1="120" x2="1130" y2="120" stroke="${LINE}" stroke-width="2"/>
  ${inner}
  <text x="70" y="580" font-family="Inter" font-weight="400" font-size="30" fill="${MUTED}">padelticker.com</text>
</svg>`;
}

function chip(x, y, label) {
  const w = 44 + label.length * 22;
  return `<rect x="${x}" y="${y}" rx="12" ry="12" width="${w}" height="52" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>
  <text x="${x + w / 2}" y="${y + 36}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="28" fill="${TEXT}">${xesc(label)}</text>`;
}

export function playerCardSvg({ name, country, stats }) {
  return frame(`
  ${country ? chip(70, 190, country) : ""}
  <text x="70" y="360" font-family="Inter" font-weight="700" font-size="88" fill="${TEXT}">${xesc(clip(name, 22))}</text>
  <rect x="72" y="392" width="120" height="6" rx="3" fill="${ACCENT}"/>
  <text x="70" y="470" font-family="Inter" font-weight="400" font-size="42" fill="${MUTED}">${xesc(stats)}</text>`);
}

export function tournamentCardSvg({ name, fed, sub }) {
  let l1 = clip(name, 26), l2 = "";
  if (name && name.length > 26) {
    const cut = name.lastIndexOf(" ", 28);
    if (cut > 10) { l1 = name.slice(0, cut); l2 = clip(name.slice(cut + 1), 26); }
  }
  return frame(`
  ${fed ? chip(70, 190, fed) : ""}
  <text x="70" y="340" font-family="Inter" font-weight="700" font-size="72" fill="${TEXT}">${xesc(l1)}</text>
  ${l2 ? `<text x="70" y="420" font-family="Inter" font-weight="700" font-size="72" fill="${TEXT}">${xesc(l2)}</text>` : ""}
  <rect x="72" y="${l2 ? 452 : 372}" width="120" height="6" rx="3" fill="${ACCENT}"/>
  <text x="70" y="${l2 ? 520 : 450}" font-family="Inter" font-weight="400" font-size="38" fill="${MUTED}">${xesc(sub)}</text>`);
}

export function fallbackCardSvg() {
  return frame(`
  <text x="70" y="360" font-family="Inter" font-weight="700" font-size="88" fill="${TEXT}">Live padel scores</text>
  <rect x="72" y="392" width="120" height="6" rx="3" fill="${ACCENT}"/>
  <text x="70" y="470" font-family="Inter" font-weight="400" font-size="42" fill="${MUTED}">Premier Padel · FIP · national tours — one live feed</text>`);
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function tournamentSub(start, end) {
  if (!start) return "Live · full draw · results & schedule";
  const s = new Date(start + "T00:00:00Z");
  const e = end ? new Date(end + "T00:00:00Z") : s;
  const y = e.getUTCFullYear();
  let range;
  if (!end || start === end) range = `${s.getUTCDate()} ${MON[s.getUTCMonth()]} ${y}`;
  else if (s.getUTCMonth() === e.getUTCMonth()) range = `${s.getUTCDate()}–${e.getUTCDate()} ${MON[s.getUTCMonth()]} ${y}`;
  else range = `${s.getUTCDate()} ${MON[s.getUTCMonth()]} – ${e.getUTCDate()} ${MON[e.getUTCMonth()]} ${y}`;
  return `${range} · draw & results`;
}

// --- render + edge cache -----------------------------------------------------
export async function ogResponse(ctx, svg) {
  const { request, waitUntil } = ctx;
  const origin = new URL(request.url).origin;
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  await ensureWasm();
  const [bold, regular] = await loadFonts(origin);
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    font: { fontBuffers: [bold, regular], loadSystemFonts: false, defaultFontFamily: "Inter" },
  });
  const png = r.render().asPng();

  const resp = new Response(png, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
  });
  waitUntil(cache.put(key, resp.clone()));
  return resp;
}
