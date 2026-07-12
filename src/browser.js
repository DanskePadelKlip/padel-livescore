// Shared headless-browser layer (Playwright). JS-only sources — Padelution
// (Livewire) and tournamentsoftware (AJAX) — expose no JSON API, so their
// adapters render the page and read the DOM through this helper. One browser
// process is reused across a run; each withPage() call gets its own context.

import { chromium } from "playwright";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

let _browser = null;

async function getBrowser() {
  if (!_browser) _browser = await chromium.launch({ headless: true });
  return _browser;
}

/**
 * Run `fn(page)` with a fresh browser context, always cleaning up.
 * @param {(page: import('playwright').Page) => Promise<T>} fn
 * @param {{userAgent?: string, storageState?: any}} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export async function withPage(fn, opts = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: opts.userAgent || DEFAULT_UA,
    storageState: opts.storageState,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

// Call once at the end of a run so the process can exit.
export async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}
