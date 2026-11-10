import type { Page } from "@playwright/test";
import { test, expect } from "../helpers/test";

// Offline READING (owner decision: no offline mutations). Needs the real service
// worker, so unlike the rest of the suite it is allowed here.
test.use({ serviceWorkers: "allow" });

type StoredRow = { id: string; readLater: boolean; openedAt: number | null };

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
              resolve(all.result.map((r) => ({ id: r.id, readLater: r.readLater, openedAt: r.openedAt })));
            };
            all.onerror = () => resolve([]);
          } catch {
            resolve([]);
          }
        };
      }),
  );
}

test.beforeEach(async ({ page }) => {
  // The headless Chromium shell crashes the renderer when the SW calls the Badge API:
  // the app's badge messages are not under test here.
  await page.addInitScript(() => {
    const post = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (this: ServiceWorker, message: unknown, ...rest: unknown[]) {
      const type = (message as { type?: string } | null)?.type;
      if (type === "SET_BADGE" || type === "CLEAR_BADGE") return;
      return (post as (...a: unknown[]) => void).call(this, message, ...rest);
    } as typeof post;
  });
});

async function openAndWaitForStore(app: import("../helpers/test").App, page: Page) {
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
  await page.goto("/settings");
  if (app.isMobile) {
    await page.getByRole("combobox").first().tap();
    await page.getByRole("option", { name: "Reading" }).tap();
  } else {
    await page.getByRole("tab", { name: "Reading" }).click();
  }
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
  await expect(page.getByTestId("offline-chip")).toHaveText("Offline – changes only when back online");
  await app.selectSidebar(/^Read later\s*\d*$/);
  await expect(app.rows()).toHaveCount(app.user.counts.readLater);
  // Still read-only.
  await app.activate(app.rows().first().getByRole("button", { name: /^(Star|Remove star)$/ }));
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Offline – changes only when back online" })).toHaveCount(1);
  await app.activate(app.rows().first());
  const article = page.locator("article");
  await expect(article).toBeVisible();
  await expect(article.locator("p").first()).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByTestId("offline-chip")).toHaveCount(0);
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
  await app.openSidebar();
  await app.activate(page.getByRole("button", { name: "Sign out" }).first());
  await app.activate(page.getByRole("alertdialog", { name: "Sign out?" }).getByRole("button", { name: "Sign out" }));
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
  expect(Object.keys(caches).every((n) => ["feedferret-pwa-v4", "feedferret-static-v1", "feedferret-runtime-v3"].includes(n))).toBe(true);
  const offline = await page.evaluate(async () => (await (await window.caches.open("feedferret-pwa-v4")).match("/offline.html"))?.text());
  expect(offline).toContain("FeedFerret Offline");
});
