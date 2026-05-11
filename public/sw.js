const CACHE_NAME = "feedferret-pwa-v1";
const PRECACHE_URLS = [
  "/offline.html",
  "/manifest.json",
  "/logo.svg",
  "/icon-192.png",
  "/icon-192-maskable.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/offline.html")),
    );
    return;
  }

  if (PRECACHE_URLS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request)),
    );
  }
});

async function updateBadge(count) {
  try {
    if (!("setAppBadge" in self.navigator) || !("clearAppBadge" in self.navigator)) return;
    if (typeof count === "number" && count > 0) {
      await self.navigator.setAppBadge(count);
    } else {
      await self.navigator.clearAppBadge();
    }
  } catch {
    // Badging is best-effort and unsupported on many browsers.
  }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || "FeedFerret";
  const options = {
    body: payload.body || "Neue Artikel verfügbar.",
    icon: "/icon-192.png",
    badge: "/icon-192-maskable.png",
    tag: payload.tag || "feedferret:notification",
    data: {
      url: payload.url || "/",
      articleId: payload.articleId,
      feedId: payload.feedId,
    },
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      updateBadge(payload.unreadCount),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client && new URL(client.url).origin === self.location.origin) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
