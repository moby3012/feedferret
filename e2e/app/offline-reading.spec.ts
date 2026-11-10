import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, App } from "../helpers/test";
import { manifest } from "../helpers/db";

// Offline READING (owner decision: no offline mutations). Needs the real service
// worker, so unlike the rest of the suite it is allowed here.
test.use({ serviceWorkers: "allow" });

type StoredRow = { id: string; userId: string; readLater: boolean; openedAt: number | null };

/** The offline store, read the way the static offline page reads it (never creates the DB). */
async function storedRows(page: Page): Promise<StoredRow[]> {
  return page.evaluate(
    () =>
      new Promise<StoredRow[]>((resolve) => {
        const open = indexedDB.open("feedferret-offline");
        open.onupgradeneeded = () => open.transaction!.abort();
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const all = db.transaction("index").objectStore("index").getAll();
            all.onsuccess = () => {
              db.close();
              resolve(all.result.map((r) => ({ id: r.id, userId: r.userId, readLater: r.readLater, openedAt: r.openedAt })));
            };
            all.onerror = () => resolve([]);
          } catch {
            resolve([]);
          }
        };
      }),
  );
}

/** A record of the store's `meta` object store (`session`, `status`), read without ever creating the DB. */
async function readMeta<T = Record<string, unknown>>(page: Page, key: string): Promise<T | undefined> {
  return page.evaluate(
    (k) =>
      new Promise<unknown>((resolve) => {
        const open = indexedDB.open("feedferret-offline");
        open.onupgradeneeded = () => open.transaction!.abort();
        open.onerror = () => resolve(undefined);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const get = db.transaction("meta").objectStore("meta").get(k);
            get.onsuccess = () => {
              db.close();
              resolve(get.result);
            };
            get.onerror = () => resolve(undefined);
          } catch {
            resolve(undefined);
          }
        };
      }),
    key,
  ) as Promise<T | undefined>;
}

/** Rewrites `session.verifiedAt` the way a device that was last online long ago would look. */
async function setVerifiedAt(page: Page, verifiedAt: number) {
  await page.evaluate(
    (at) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("feedferret-offline");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("meta", "readwrite");
          const meta = tx.objectStore("meta");
          const get = meta.get("session");
          get.onsuccess = () => meta.put({ ...get.result, verifiedAt: at }, "session");
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    verifiedAt,
  );
}

test.beforeEach(async ({ page }) => {
  // The headless Chromium shell crashes the renderer when the SW calls the Badge API: the app's badge
  // messages are not sent in this file (context-wide, so extra tabs are covered too). The badge logic itself
  // is NOT shimmed where it can be tested for real: tests/features/service-worker.test.ts drives public/sw.js's
  // SET_BADGE / CLEAR_BADGE handlers against a fake Badge API. A real-browser badge check is not feasible
  // here because it is exactly what crashes the renderer in this environment.
  await page.context().addInitScript(() => {
    const post = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (this: ServiceWorker, message: unknown, ...rest: unknown[]) {
      const type = (message as { type?: string } | null)?.type;
      if (type === "SET_BADGE" || type === "CLEAR_BADGE") return;
      return (post as (...a: unknown[]) => void).call(this, message, ...rest);
    } as typeof post;
  });
});

async function openAndWaitForStore(app: App, page: Page) {
  await app.open();
  await page.evaluate(() => navigator.serviceWorker.ready);
  const expected = app.user.counts.readLater;
  expect(expected).toBeGreaterThan(0);
  await expect.poll(async () => (await storedRows(page)).filter((r) => r.readLater).length, { timeout: 60_000 }).toBe(expected);
}

test("prefetches every Read-later body, bounded and per user", async ({ app, page }) => {
  await openAndWaitForStore(app, page);
  const rows = await storedRows(page);
  expect(rows.length).toBeLessThanOrEqual(300);
  // Storage was asked to persist (best effort: the headless browser may decline, the API must exist).
  expect(await page.evaluate(() => typeof navigator.storage?.persist)).toBe("function");
  // Settings shows what is stored.
  await app.openSettings("Reading");
  await expect(page.getByTestId("offline-usage")).toContainText(`${rows.length} articles`);
});

test("reload while offline: the offline page lists Read later and opens a body", async ({ app, page, context }) => {
  await openAndWaitForStore(app, page);
  await context.setOffline(true);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "You are offline" })).toBeVisible();
  const later = page.locator("#sections > div").filter({ has: page.getByRole("heading", { name: "Read later" }) });
  await expect(later.locator("li")).toHaveCount(app.user.counts.readLater);
  await later.locator("li button").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  // The body renders (script-less sandboxed frame), not just the title.
  await expect(page.frameLocator("#body").locator("p").first()).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.locator("#lists")).toBeVisible();
  await context.setOffline(false);
});

test("connection drops inside the app: Read later list and reader open from the store, toggles stay refused", async ({ app, page, context }) => {
  await openAndWaitForStore(app, page);
  await context.setOffline(true);
  await expect(page.getByTestId("offline-chip")).toBeVisible();
  // Compact chip: icon + "Offline"; the full sentence is its name / tooltip.
  await expect(page.getByTestId("offline-chip")).toHaveText("Offline");
  await expect(page.getByTestId("offline-chip")).toHaveAccessibleName("Offline – changes only when back online");
  await app.selectSidebar(/^Read later\s*\d*$/);
  await expect(app.rows()).toHaveCount(app.user.counts.readLater);
  // Still read-only.
  await app.toggle(app.rows().first().locator('[role="button"]').first(), "star");
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Offline – changes only when back online" })).toHaveCount(1);
  await app.activate(app.rows().first());
  const article = page.locator("article");
  await expect(article).toBeVisible();
  await expect(article.locator("p").first()).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByTestId("offline-chip")).toHaveCount(0);
});

test("fresh session, then offline: a stored article opens with the full reader chrome (body, bar, pill, menu, Aa sheet)", async ({ app, page, context }) => {
  // A fresh document: the store is filled only after the offline layer warmed the lazy shell chunks
  // (features/offline/warm-chunks.ts → the reader's body / chrome / "…" menu / "Aa" sheet).
  await openAndWaitForStore(app, page);
  const chunkErrors: string[] = [];
  page.on("pageerror", (e) => /ChunkLoadError|Loading chunk|dynamically imported module/i.test(e.message) && chunkErrors.push(e.message));
  page.on("console", (m) => m.type() === "error" && /ChunkLoadError|Loading chunk/i.test(m.text()) && chunkErrors.push(m.text()));
  await context.setOffline(true);
  try {
    await expect(page.getByTestId("offline-chip")).toBeVisible();
    await app.selectSidebar(/^Read later\s*\d*$/);
    await app.activate(app.rows().first());
    const reader = page.locator('[data-pane="reader"]');
    await expect(reader.locator("article .article-content p").first()).toBeVisible();
    const bar = reader.locator(".ff-reader-bar");
    await expect(bar.getByRole("button", { name: "Previous article" })).toBeVisible();
    if (app.isMobile) await expect(reader.getByRole("navigation", { name: "Article actions" })).toBeVisible();
    // The two sub-chunks of the chrome open offline too.
    await app.activate(bar.getByRole("button", { name: "Text appearance" }));
    await expect(page.getByRole("dialog", { name: "Text appearance" }).getByRole("radio", { name: "Serif" })).toBeVisible();
    await page.keyboard.press("Escape");
    await app.activate(reader.getByRole("button", { name: "More actions" }).first());
    await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(chunkErrors).toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});

test("opened articles are kept as 'recently read offline'", async ({ app, page, context }) => {
  await app.open();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await app.activate(app.row(2));
  await expect(page.locator("article")).toBeVisible();
  await expect.poll(async () => (await storedRows(page)).some((r) => r.id === app.articleId(2) && r.openedAt)).toBe(true);
  await context.setOffline(true);
  await page.goto("/");
  const recent = page.locator("#sections > div").filter({ has: page.getByRole("heading", { name: "Recently read offline" }) });
  await expect(recent.locator("li")).toHaveCount(1);
  await context.setOffline(false);
});

test("signing out clears the offline store", async ({ app, page }) => {
  await openAndWaitForStore(app, page);
  expect((await storedRows(page)).length).toBeGreaterThan(0);
  const dialog = await app.startSignOut();
  await app.activate(dialog.getByRole("button", { name: "Sign out" }));
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  expect(await storedRows(page)).toEqual([]);
});

test("service worker precache is intact and holds no authenticated data", async ({ app, page }) => {
  await app.open();
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Make sure the SW controls the page before judging its caches.
  await page.reload();
  await app.navReady();
  const caches = await page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    for (const name of await window.caches.keys()) out[name] = (await (await window.caches.open(name)).keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
    return out;
  });
  expect(caches["feedferret-pwa-v4"]).toEqual(expect.arrayContaining(["/offline.html", "/offline-reader.js", "/manifest.json", "/logo.svg"]));
  for (const urls of Object.values(caches)) expect(urls.filter((u) => u.startsWith("/api/"))).toEqual([]);
  // No authenticated HTML either: the only page in any cache is the public offline page.
  for (const urls of Object.values(caches)) expect(urls.filter((u) => u === "/" || u.startsWith("/?") || u.startsWith("/settings"))).toEqual([]);
  expect(Object.keys(caches).every((n) => ["feedferret-pwa-v4", "feedferret-static-v1", "feedferret-runtime-v3", "feedferret-settings-v1"].includes(n))).toBe(true);
  // The settings cache holds the per-device badge switch (sent on every shell start) and nothing else.
  for (const url of caches["feedferret-settings-v1"] ?? []) expect(url).toBe("/__feedferret/badge-pref");
  const offline = await page.evaluate(async () => (await (await window.caches.open("feedferret-pwa-v4")).match("/offline.html"))?.text());
  expect(offline).toContain("FeedFerret Offline");
});

// ---------------------------------------------------------------- session policy (review findings)

const DAY = 24 * 60 * 60 * 1000;

function otherUserKey(app: App) {
  return app.userKey === "desktop" ? "mobile" : "desktop";
}

async function signInAs(page: Page, userKey: string) {
  const m = manifest();
  // Sign-in is rate limited per client IP (10 per 15 min, in memory in the one server of the run). Every
  // sign-in of this file comes from its own address so the budget shared with the rest of the suite (and
  // with --repeat-each) can never decide the outcome. Only the address differs: the limiter itself
  // is still what the app ships (covered in tests/lib/rate-limit.test.ts).
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `10.${randomInt(256)}.${randomInt(256)}.${1 + randomInt(254)}` });
  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(m.users[userKey].email);
  await page.getByPlaceholder("Password").fill(m.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
}

test("the stored session is bound to the account: userId + generation", async ({ app, page }) => {
  await openAndWaitForStore(app, page);
  const session = await readMeta<{ userId: string; gen: string; verifiedAt: number }>(page, "session");
  expect(session?.userId).toBe(app.user.userId);
  expect(session?.gen).toBeTruthy();
  expect(Math.abs(Date.now() - session!.verifiedAt)).toBeLessThan(5 * 60_000);
  expect((await storedRows(page)).every((r) => r.userId === app.user.userId)).toBe(true);
});

test("account switch in another tab: the stale tab stops, reloads into the new account, the store never mixes accounts", async ({ app, page, context }) => {
  test.setTimeout(150_000);
  await openAndWaitForStore(app, page);
  const before = await readMeta<{ gen: string }>(page, "session");
  const other = otherUserKey(app);
  const otherUser = manifest().users[other];

  // Another tab takes the device over as somebody else (the session cookie is shared by all tabs).
  await context.clearCookies();
  await context.addCookies(JSON.parse(readFileSync(path.resolve("e2e", ".auth", `${other}.json`), "utf8")).cookies);
  const second = await context.newPage();
  await second.goto("/");

  // The first tab (still showing the old account) leaves by itself and ends up in the new account.
  await expect.poll(() => page.locator(`[data-article-id^="e2e-${other}-"]`).count(), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.locator(`[data-article-id^="e2e-${app.userKey}-"]`)).toHaveCount(0);

  // New generation, new owner; not one row of the previous account survived.
  await expect.poll(async () => (await readMeta<{ userId: string }>(second, "session"))?.userId).toBe(otherUser.userId);
  const after = await readMeta<{ gen: string }>(second, "session");
  expect(after!.gen).not.toBe(before!.gen);
  await expect.poll(async () => (await storedRows(second)).length, { timeout: 60_000 }).toBeGreaterThan(0);
  for (let i = 0; i < 5; i++) {
    expect((await storedRows(second)).every((r) => r.userId === otherUser.userId)).toBe(true);
    await second.waitForTimeout(500);
  }
  await second.close();
});

test("sign-out in another tab: a prefetch still in flight in this tab leaves nothing behind", async ({ app, page, context }) => {
  // Hold every body request of the prefetch (the "delayed response").
  const held: Array<import("@playwright/test").Route> = [];
  await page.route(/\/api\/app\/articles\/(?!count)[^/?]+$/, (route) => {
    held.push(route);
  });
  await app.open();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => held.length, { timeout: 60_000 }).toBeGreaterThan(0);

  const second = await context.newPage();
  const secondApp = new App(second, app.isMobile, app.user, app.userKey);
  await second.goto("/");
  await secondApp.navReady();
  const dialog = await secondApp.startSignOut();
  // Sign-out must be accepted by the server: its own rate-limit budget, never the sign-in one (a refused
  // sign-out answers 429, leaves the session cookie valid and this tab on "/" — the original flake).
  const signOutResponse = second.waitForResponse((r) => r.url().endsWith("/api/auth/signout") && r.request().method() === "POST");
  await secondApp.activate(dialog.getByRole("button", { name: "Sign out" }));
  expect((await signOutResponse).status()).toBe(200);
  await second.waitForURL(/\/login/, { timeout: 30_000 });
  // The signed-out tab leaves by itself, even though it never saw a response.
  await page.waitForURL(/\/login/, { timeout: 30_000 });

  // Now the delayed answers arrive.
  for (const route of held.splice(0)) await route.continue().catch(() => {});
  await page.waitForTimeout(2500);
  expect(await readMeta(second, "session")).toBeUndefined();
  expect(await storedRows(second)).toEqual([]);

  // The next person on this device starts clean.
  const other = otherUserKey(app);
  await signInAs(second, other);
  await expect.poll(async () => (await readMeta<{ userId: string }>(second, "session"))?.userId).toBe(manifest().users[other].userId);
  expect((await storedRows(second)).every((r) => r.userId === manifest().users[other].userId)).toBe(true);
  await second.close();
});

test("expiry: data not confirmed by the server for over 30 days is neither shown nor kept (direct offline page)", async ({ app, page, context }) => {
  await openAndWaitForStore(app, page);
  await setVerifiedAt(page, Date.now() - 31 * DAY);
  await context.setOffline(true);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "You are offline" })).toBeVisible();
  await expect(page.locator("#sections li")).toHaveCount(0);
  await expect(page.locator("#intro")).toContainText("expired");
  await context.setOffline(false);
  expect(await storedRows(page)).toEqual([]);
  expect(await readMeta(page, "session")).toBeUndefined();
});

test("within 30 days the offline page still works without the server confirming (offline)", async ({ app, page, context }) => {
  await openAndWaitForStore(app, page);
  await setVerifiedAt(page, Date.now() - 29 * DAY);
  await context.setOffline(true);
  await page.goto("/");
  await expect(page.locator("#sections li").first()).toBeVisible();
  await context.setOffline(false);
});

test("online, the offline page verifies the session: a dead session (401) clears the store", async ({ app, page, context }) => {
  await openAndWaitForStore(app, page);
  expect((await storedRows(page)).length).toBeGreaterThan(0);
  await context.clearCookies(); // the session is gone, the data is not (yet)
  await page.goto("/offline.html");
  await expect(page.locator("#intro")).toContainText("no longer valid");
  await expect(page.locator("#sections li")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  expect(await storedRows(page)).toEqual([]);
});

test("online, the offline page verifies the identity: another account's data is cleared", async ({ app, page }) => {
  await openAndWaitForStore(app, page);
  // Pretend the store belongs to somebody else than the signed-in account.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const open = indexedDB.open("feedferret-offline");
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("meta", "readwrite");
          const meta = tx.objectStore("meta");
          const get = meta.get("session");
          get.onsuccess = () => meta.put({ ...get.result, userId: "somebody-else" }, "session");
          tx.oncomplete = () => (db.close(), resolve());
        };
      }),
  );
  await page.goto("/offline.html");
  await expect(page.locator("#intro")).toContainText("no longer valid");
  await expect.poll(async () => (await storedRows(page)).length).toBe(0);
});

test("slow server: the offline page offers 'keep waiting' / offline view instead of switching hard", async ({ app, page }) => {
  await openAndWaitForStore(app, page);
  // The service worker marks the page it shows for a HANGING request; simulate the mark (its logic is unit-tested).
  await page.addInitScript(() => {
    if (location.pathname !== "/offline.html") return;
    new MutationObserver((_, observer) => {
      if (!document.body) return;
      document.body.setAttribute("data-mode", "slow");
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto("/offline.html");
  await expect(page.locator("#slow")).toBeVisible();
  await expect(page.locator("#slow-text")).toContainText("answering slowly");
  await expect(page.locator("#lists")).toBeHidden();
  await page.getByRole("button", { name: "Offline view" }).click();
  await expect(page.locator("#sections li").first()).toBeVisible();
  await expect(page.locator("#slow")).toBeHidden();
});

test("storage full: older entries are evicted, the retry failure is reported in the settings line", async ({ app, page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "bodies") {
        this.transaction!.abort(); // what a full disk does: the whole transaction goes
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      return put.apply(this, args);
    } as typeof put;
  });
  await app.open();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(async () => (await readMeta<{ quotaFailed: boolean }>(page, "status"))?.quotaFailed, { timeout: 60_000 }).toBe(true);
  expect((await storedRows(page)).filter((r) => r.readLater)).toHaveLength(0);
  await app.openSettings("Reading");
  await expect(page.getByTestId("offline-quota-warning")).toBeVisible();
});

test("server unreachable while the browser says online: the fallback list is replaced once the server answers again", async ({ app, page }) => {
  await openAndWaitForStore(app, page);
  // The server "goes away" (proxy 502) — no `offline` event, navigator.onLine stays true.
  const outage = /\/api\/app\/(articles|session)/;
  await page.route(outage, (route) => route.fulfill({ status: 502, body: "bad gateway" }));
  await app.selectSidebar(/^Starred\s*\d*$/);
  // The Starred list is answered from the store …
  // … and, nobody sending an `online` event, the probe finds the recovered server by itself.
  const refetched = page.waitForRequest((r) => /\/api\/app\/articles\?/.test(r.url()) && r.url().includes("v=starred"), { timeout: 60_000 });
  await page.unroute(outage);
  await refetched;
});

test("a slow page of account A is never handed to account B: 'keep waiting' is a brand-new navigation", async ({ app, page, context }) => {
  test.setTimeout(150_000);
  await openAndWaitForStore(app, page);
  const sw = context.serviceWorkers().find((w) => w.url().endsWith("/sw.js")) ?? (await context.waitForEvent("serviceworker"));
  // Inside the real worker, make one URL hang for account "A" (what a cold server does) and answer instantly for "B".
  await sw.evaluate(() => {
    const g = globalThis as unknown as {
      fetch: typeof fetch;
      __account: string;
      __held: Array<() => void>;
    };
    const real = g.fetch.bind(globalThis);
    g.__account = "A";
    g.__held = [];
    const answer = (who: string) =>
      new Response(`<!doctype html><title>${who}</title><body>PAGE-OF-${who}</body>`, { status: 200, headers: { "content-type": "text/html" } });
    g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname !== "/e2e-slow-probe") return real(input, init);
      if (g.__account !== "A") return Promise.resolve(answer("B"));
      return new Promise<Response>((resolve, reject) => {
        g.__held.push(() => resolve(answer("A")));
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as typeof fetch;
  });

  const probe = await context.newPage();
  await probe.goto("/e2e-slow-probe"); // 8 s later the worker shows the offline page in "slow" mode
  await expect(probe.locator("#slow")).toBeVisible({ timeout: 30_000 });

  // A signs out, B signs in on the same device — and only then A's server answers.
  const other = otherUserKey(app);
  await context.clearCookies();
  await context.addCookies(JSON.parse(readFileSync(path.resolve("e2e", ".auth", `${other}.json`), "utf8")).cookies);
  await sw.evaluate(() => {
    const g = globalThis as unknown as { __account: string; __held: Array<() => void> };
    g.__account = "B";
    for (const release of g.__held.splice(0)) release();
  });

  await probe.getByRole("button", { name: "Keep waiting" }).click();
  await expect(probe.locator("body")).toContainText("PAGE-OF-B", { timeout: 30_000 });
  await expect(probe.locator("body")).not.toContainText("PAGE-OF-A");
  await probe.close();
});

test("offline page: the session ending in another tab empties the rendered lists and the open article at once", async ({ app, page, context }) => {
  test.setTimeout(90_000);
  await openAndWaitForStore(app, page);
  await page.goto("/offline.html");
  await expect(page.locator("#sections li").first()).toBeVisible();
  await page.locator("#sections li button").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("#body")).toHaveAttribute("srcdoc", /<body>/);

  // Another tab ends the session. (Not through the UI sign-out button: the suite shares one rate limit for
  // POST /api/auth/signout and the other specs already use it up. The login page clears the store and tells every tab.)
  await context.clearCookies();
  const second = await context.newPage();
  await second.goto("/login");

  // The offline tab (still open, nobody reloaded it) lets go of everything it rendered.
  await expect(page.locator("#intro")).toContainText("no longer valid", { timeout: 15_000 });
  await expect(page.locator("#sections li")).toHaveCount(0);
  await expect(page.locator("#reader")).toBeHidden();
  await expect(page.locator("#r-title")).toHaveText("");
  await expect(page.locator("#body")).not.toHaveAttribute("srcdoc", /.*/);
  await second.close();
});

test("offline page restored from the back/forward cache (pageshow persisted) is re-validated before it is trusted", async ({ app, page, context }) => {
  await openAndWaitForStore(app, page);
  await page.goto("/offline.html");
  await expect(page.locator("#sections li").first()).toBeVisible();
  await context.clearCookies(); // the session ended while the page sat frozen
  await page.evaluate(() => {
    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: true });
    window.dispatchEvent(event);
  });
  await expect(page.locator("#intro")).toContainText("no longer valid", { timeout: 15_000 });
  await expect(page.locator("#sections li")).toHaveCount(0);
  await expect(page.locator("body[data-checking]")).toHaveCount(0);
  expect(await storedRows(page)).toEqual([]);
});
