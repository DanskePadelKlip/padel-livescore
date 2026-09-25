// Thin HTTP layer for RankedIn's public JSON API.
// Anonymous access works, but a browser User-Agent + Referer are REQUIRED
// (see memory: rankedin-dpf-api). Keep this the ONE place that knows the base
// URL and headers so adapters stay declarative.

const BASE = "https://api.rankedin.com/v1/";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Referer: "https://www.rankedin.com/",
  Accept: "application/json",
};

// Every attempt is bounded. Without this a hung RankedIn connection stalled the
// whole refresh cycle indefinitely: retries=2 means 3 attempts, and with no timeout
// each one could hang forever, so the daemon sat mid-fetch producing no output and
// no health.json while /api/health's dead-man's switch reported the site down.
// Observed 2026-08-28 as a single 393s fetch phase against a normal 42-78s.
// Worst case is now ~3 x REQ_TIMEOUT_MS + backoff.
const REQ_TIMEOUT_MS = 20_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function rankedinGet(path, { retries = 2 } = {}) {
  const url = path.startsWith("http") ? path : BASE + path;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}
