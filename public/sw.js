// PadelTicker service worker — Web Push (Phase A).
// Receives push messages and shows a notification; focuses/opens the site on click.

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data && event.data.text() }; }
  const title = d.title || "PadelTicker";
  const options = {
    body: d.body || "",
    tag: d.tag || undefined,          // same tag replaces an existing notification
    data: { url: d.url || "https://padelticker.com/" },
    ...(d.icon ? { icon: d.icon } : {}),
    ...(d.badge ? { badge: d.badge } : {}),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "https://padelticker.com/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith("https://padelticker.com") && "focus" in w) return w.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

// Minimal fetch handler (network pass-through) — its presence lets the app be
// installable as a PWA. No offline caching on purpose: the app is live data and
// we already control asset freshness via versioned app.js.
self.addEventListener("fetch", () => {});

// take over immediately so updates apply without a manual reload
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
