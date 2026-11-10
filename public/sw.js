// Cache layout
//  - PRECACHE   static shell for offline use (offline page + its reader script + icons). Survives logout.
//  - STATIC     `/_next/static/*`: content-hashed, immutable → cache-first, bounded. Public bundles, survives logout.
//  - RUNTIME    other same-origin script/style/image/font → stale-while-revalidate, bounded. Cleared on logout (lib/logout.ts).
// Never cached here: navigations (they carry the signed-in user's page) and `/api/*` (authenticated JSON).
// Offline article data lives in IndexedDB (features/offline), not in these caches.
const CACHE_NAME = "feedferret-pwa-v4";
const STATIC_CACHE = "feedferret-static-v1";
const RUNTIME_CACHE = "feedferret-runtime-v3";
const STATIC_MAX_ENTRIES = 150;
const RUNTIME_MAX_ENTRIES = 60;
// Network-first navigations give up on a hanging connection ("lie-fi") after this
// and show the offline page, which lists what is stored for offline reading.
const NAVIGATION_TIMEOUT_MS = 3000;
// cache.addAll() is all-or-nothing: a single 404 in this list fails the whole
// install event, so the service worker never installs at all (not even
// partially) for any user. Keep this to files that actually exist and that
// the SW itself needs to serve offline — PWA-manifest screenshots are never
// served through the SW's fetch handler (browsers fetch them directly for
// the install-prompt UI), so they don't belong here.
const PRECACHE_URLS = [
  "/offline.html",
  "/offline-reader.js",
  "/manifest.json",
  "/logo.svg",
  "/icon-192.png",
  "/icon-192-maskable.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
];
const KNOWN_CACHES = [CACHE_NAME, STATIC_CACHE, RUNTIME_CACHE];

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
      .then((keys) => Promise.all(keys.filter((key) => !KNOWN_CACHES.includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Oldest entries first (insertion order) until at most `max` remain. */
async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((key) => cache.delete(key)));
}

function cacheable(response) {
  return (
    response.ok &&
    response.status === 200 &&
    response.type === "basic" &&
    !/private|no-store/i.test(response.headers.get("cache-control") || "")
  );
}

async function cacheFirst(event, cacheName, max) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (cacheable(response)) {
    event.waitUntil(cache.put(event.request, response.clone()).then(() => trimCache(cacheName, max)));
  }
  return response;
}

async function staleWhileRevalidate(event, cacheName, max) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);
  const network = fetch(event.request)
    .then((response) => {
      if (cacheable(response)) {
        event.waitUntil(cache.put(event.request, response.clone()).then(() => trimCache(cacheName, max)));
      }
      return response;
    })
    .catch(() => cached || Response.error());
  return cached || network;
}

async function offlinePage() {
  const cache = await caches.open(CACHE_NAME);
  return (
    (await cache.match("/offline.html")) ||
    new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } })
  );
}

/** Network-first; a failed or hanging (> NAVIGATION_TIMEOUT_MS) request falls back to the offline page. HTTP errors pass through. */
async function navigate(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
  try {
    return await fetch(request, { signal: controller.signal });
  } catch {
    return offlinePage();
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }

  // Authenticated API responses never enter a Cache Storage cache.
  if (url.pathname.startsWith("/api/")) return;

  if (PRECACHE_URLS.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(event, STATIC_CACHE, STATIC_MAX_ENTRIES));
    return;
  }

  if (
    request.destination === "script" ||
    request.destination === "style" ||
    request.destination === "image" ||
    request.destination === "font"
  ) {
    event.respondWith(staleWhileRevalidate(event, RUNTIME_CACHE, RUNTIME_MAX_ENTRIES));
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

self.addEventListener("message", (event) => {
  if (event.data?.type === "SET_BADGE") {
    event.waitUntil(updateBadge(event.data.count));
  }
  if (event.data?.type === "CLEAR_BADGE") {
    event.waitUntil(updateBadge(0));
  }
});

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
