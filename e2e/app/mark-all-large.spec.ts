import { test, expect, ACTIVE_LIST } from "../helpers/test";
import { insertArrivals, insertBulkFeed, readFlags } from "../helpers/db";

/**
 * "Alle als gelesen" on a feed with thousands of articles (owner bug: slow /
 * failing bulk mark). The loaded rows flip at once (optimistic, by scope) even
 * while the server call is still running; the server marks the whole feed
 * set-based; articles that arrived after the list was loaded stay unread; one
 * Undo restores everything.
 */
test("mark all read on a 5 000-article feed: instant rows, whole feed on the server, cutoff, Undo", async ({ app, page }) => {
  test.setTimeout(180_000);
  const bulk = insertBulkFeed(app.userKey, 5000);
  let arrivals: { ids: string[]; cleanup: () => void } | null = null;
  try {
    await page.goto(`/?feed=${bulk.feedId}`);
    await app.navReady();
    const first = page.locator(`${ACTIVE_LIST} [data-article-id="${bulk.ids[0]}"]`).first();
    await expect(first).toBeVisible({ timeout: 30_000 });
    await expect(first).toHaveAttribute("data-unread", "");

    // A sync delivers new items after the list snapshot (they sit behind the "new" pill).
    arrivals = insertArrivals(app.userKey, 3, "markall", bulk.feedId);

    // Hold the server action back: the visible rows must already show read.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) return route.fallback();
      await held;
      await route.continue();
    });
    const unreadRows = page.locator(`${ACTIVE_LIST} [data-article-id^="e2e-bulk-"][data-unread]`);
    expect(await unreadRows.count()).toBeGreaterThan(0);
    await app.markAllRead();
    // Optimistic: every loaded row is read (and leaves the unread list) before the server answers.
    await expect(unreadRows).toHaveCount(0, { timeout: 2000 });
    expect([...readFlags(bulk.ids).values()].filter(Boolean)).toHaveLength(0);
    release();

    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Marked 5,000 articles as read" });
    await expect(toast).toBeVisible({ timeout: 30_000 });
    expect([...readFlags(bulk.ids).values()].filter((read) => !read)).toHaveLength(0);
    expect([...readFlags(arrivals.ids).values()].some(Boolean)).toBe(false);

    await app.activate(toast.getByRole("button", { name: "Undo" }));
    await expect.poll(() => [...readFlags(bulk.ids).values()].filter(Boolean).length, { timeout: 30_000 }).toBe(0);
  } finally {
    arrivals?.cleanup();
    bulk.cleanup();
  }
});
