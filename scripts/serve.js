// Zero-dependency static server for the public/ folder, so the browser can
// fetch data/matches.json (file:// would be blocked by CORS).
//
//   node scripts/serve.js   ->   http://localhost:8787

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = process.env.PORT || 8787;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel === "/") rel = "/index.html";
    // prevent path traversal
    const filePath = normalize(join(PUBLIC, rel));
    if (!filePath.startsWith(PUBLIC)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    // SPA fallback. In production every client route (/player/…, /tournament/…,
    // /match/…) is served the app shell by a Pages Function; without this the dev
    // server 404s on all of them and deep links can only be tested after a deploy.
    // Extension-less paths only, so a genuinely missing asset still reports 404.
    try {
      if (!extname(new URL(req.url, "http://x").pathname)) {
        const body = await readFile(join(PUBLIC, "index.html"));
        res.writeHead(200, { "Content-Type": TYPES[".html"] });
        res.end(body);
        return;
      }
    } catch {}
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}).listen(PORT, () => console.log(`\n🎾 padel-livescore → http://localhost:${PORT}\n`));
