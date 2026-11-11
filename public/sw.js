// Cache layout
//  - PRECACHE   static shell for offline use (offline page + its reader script + icons). Survives logout.
//  - STATIC     `/_next/static/*`: content-hashed, immutable → cache-first, bounded. Public bundles, survives logout.
//  - RUNTIME    other same-origin script/style/image/font → stale-while-revalidate, bounded. Cleared on logout (lib/logout.ts).
// Never cached here: navigations (they carry the signed-in user's page — the only HTML ever stored is the public
// /offline.html from the precache, also when it is served in place of a slow page) and `/api/*` (authenticated JSON).
// Offline article data lives in IndexedDB (features/offline), not in these caches.
const CACHE_NAME = "feedferret-pwa-v5";
const STATIC_CACHE = "feedferret-static-v1";
const RUNTIME_CACHE = "feedferret-runtime-v3";
const STATIC_MAX_ENTRIES = 150;
const RUNTIME_MAX_ENTRIES = 60;
// Network-first navigations. A connection that fails outright shows the offline page at once. One that merely
// HANGS ("lie-fi", cold server) is given NAVIGATION_TIMEOUT_MS; then the offline page is shown in its "slow" mode —
// "server answering slowly: offline view / keep waiting" — and that request is aborted. "Keep waiting" is a plain
// reload = a fresh navigation (fresh cookies, fresh response). The worker never keeps a response for a later request.
const NAVIGATION_TIMEOUT_MS = 8000;
// Sign-in and OAuth hops are never second-guessed by a timer (a slow identity provider is normal there): no slow
// page, no abort — only a hard network failure falls back to the offline page.
const PATIENT_PATHS = ["/login", "/register", "/setup"];
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
// Per-device settings the worker needs while no page is open (app badge on/off).
const SETTINGS_CACHE = "feedferret-settings-v1";
const BADGE_PREF_URL = "/__feedferret/badge-pref";
const KNOWN_CACHES = [CACHE_NAME, STATIC_CACHE, RUNTIME_CACHE, SETTINGS_CACHE];

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

function isPatientNavigation(url) {
  return PATIENT_PATHS.includes(url.pathname) || url.pathname === "/api" || url.pathname.startsWith("/api/");
}

/** The precached offline page, flagged as "slow" (the request is still running) for its script. */
async function slowPage() {
  const page = await offlinePage();
  if (page.status !== 200) return page;
  const html = (await page.text()).replace("<body>", '<body data-mode="slow">');
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/**
 * Network-first. HTTP errors pass through; a failed request shows the offline page; a hanging one the "slow"
 * offline page and the request is ABORTED. Nothing of a navigation outlives its own response: "keep waiting"
 * is a plain reload, i.e. a brand-new navigation with the cookies of whoever is signed in at that moment.
 * (A page that was kept by URL and handed to the next navigation could carry one account's HTML into another
 * account's tab or past a logout.)
 */
async function navigate(event) {
  const { request } = event;
  if (isPatientNavigation(new URL(request.url))) {
    try {
      return await fetch(request);
    } catch {
      return offlinePage();
    }
  }
  const controller = new AbortController();
  const attempt = fetch(request, { signal: controller.signal });
  event.waitUntil(attempt.then(() => {}, () => {}));
  let timer;
  const outcome = await Promise.race([
    attempt.then((response) => ({ response }), () => ({ failed: true })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ slow: true }), NAVIGATION_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (outcome.response) return outcome.response;
  if (outcome.failed) return offlinePage();
  controller.abort(); // the answer, if it ever comes, is dropped — never kept for a later request
  return slowPage();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(navigate(event));
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

/** Settings → Benachrichtigungen → "Badge am App-Symbol" (default on). */
async function badgeEnabled() {
  try {
    const cache = await caches.open(SETTINGS_CACHE);
    const stored = await cache.match(BADGE_PREF_URL);
    return !stored || (await stored.text()) !== "0";
  } catch {
    return true;
  }
}

async function setBadgeEnabled(enabled) {
  try {
    const cache = await caches.open(SETTINGS_CACHE);
    await cache.put(BADGE_PREF_URL, new Response(enabled ? "1" : "0"));
  } catch {
    // Without Cache Storage the page still clears the badge itself.
  }
  if (!enabled) await updateBadge(0);
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "BADGE_PREF") {
    event.waitUntil(setBadgeEnabled(event.data.enabled !== false));
  }
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
      badgeEnabled().then((enabled) => (enabled ? updateBadge(payload.unreadCount) : undefined)),
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
