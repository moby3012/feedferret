import { allowInternalFeedUrls, brokenFeedState, feedArchiveState, insertBrokenFeed, insertInactiveFeed } from "../helpers/db";
import { test, expect } from "../helpers/test";

/**
 * "Defekte Feeds": the triage list for muted / failing feeds. Feeds are inserted per test
 * (and removed again in afterEach — a re-test may also have synced articles into them), so
 * the shared seed is never changed. Re-tests fetch from the local fixture server
 * (e2e/fixtures/feed-server.mjs, /broken/*) while the instance "allow internal feed URLs"
 * switch is on, which is restored afterwards.
 */
const fixture = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT || 4010}`;
const PAGE = "/manage-feeds?tab=broken";

let restoreInternal: (() => void) | undefined;
const cleanups: Array<() => void> = [];

test.beforeEach(async ({ request }) => {
  restoreInternal = allowInternalFeedUrls();
  await request.get(`${fixture}/broken/break`);
});
test.afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  restoreInternal?.();
  restoreInternal = undefined;
});

function track<T extends { cleanup: () => void }>(feed: T): T {
  cleanups.push(feed.cleanup);
  return feed;
}

const card = (page: import("@playwright/test").Page, name: string) => page.getByTestId("broken-feed").filter({ has: page.getByRole("heading", { name, exact: true }) });

test("lists muted and failing feeds with plain-language reasons: muted first, healthy feeds absent", async ({ app, page }) => {
  track(insertBrokenFeed(app.userKey, { name: "Aa Missing", url: "https://broken-a.e2e.test/feed.xml", failures: 4, lastError: "Error: Fetch failed: 404", failingDays: 5 }));
  track(insertBrokenFeed(app.userKey, { name: "Mm Offline", url: "https://broken-m.e2e.test/feed.xml", failures: 6, lastError: "TypeError: fetch failed", failingDays: 9 }));
  track(insertBrokenFeed(app.userKey, { name: "Zz Forbidden", url: "https://broken-z.e2e.test/feed.xml", autoMuted: true, failures: 10, lastError: "Error: Fetch failed: 403", failingDays: 12 }));

  await page.goto(PAGE);
  const cards = page.getByTestId("broken-feed");
  await expect(cards).toHaveCount(3);
  expect(await cards.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.feedName))).toEqual(["Zz Forbidden", "Mm Offline", "Aa Missing"]);

  const forbidden = card(page, "Zz Forbidden");
  await expect(forbidden.getByTestId("broken-category")).toHaveText("Access denied – maybe login or bot protection");
  await expect(forbidden.getByTestId("broken-muted")).toBeVisible();
  await expect(forbidden).toContainText("broken-z.e2e.test");
  await expect(forbidden).toContainText("10 failed attempts in a row");
  await expect(forbidden).toContainText("Failing since");
  await expect(forbidden).toContainText("Last success: unknown");
  await expect(card(page, "Mm Offline").getByTestId("broken-category")).toHaveText("Unreachable");
  await expect(card(page, "Aa Missing").getByTestId("broken-category")).toHaveText("Not found – did the feed move?");
  await expect(card(page, "Aa Missing").getByTestId("broken-muted")).toHaveCount(0);
  await expect(page.getByTestId("broken-feeds-summary")).toHaveText("3 broken feeds · 1 of them muted");
  // the tab label carries the count
  await expect(page.getByRole("tab", { name: "Broken feeds (3)" })).toBeVisible();
});

test("shows an empty state when nothing is broken", async ({ page }) => {
  await page.goto(PAGE);
  await expect(page.getByTestId("broken-feeds-empty")).toBeVisible();
  await expect(page.getByTestId("broken-feed")).toHaveCount(0);
});

test.describe("entry points", () => {
  test("the Feeds screen / sidebar row and the notifications link open the list", async ({ app, page }) => {
    track(insertBrokenFeed(app.userKey, { name: "Entry broken", url: "https://broken-entry.e2e.test/feed.xml", autoMuted: true, failures: 10 }));
    await app.open();
    if (app.isMobile) {
      await app.openSidebar();
      const row = app.sidebar().getByTestId("feeds-broken");
      await expect(row).toContainText("Broken feeds");
      await expect(row).toContainText("1");
      await app.activate(row.getByRole("button"));
    } else {
      await page.setViewportSize({ width: 2000, height: 950 });
      await page.goto("/");
      await expect(page.getByTestId("sidebar-broken-feeds")).toBeVisible();
      await page.getByRole("button", { name: "Notifications" }).click();
      const link = page.getByTestId("notifications-broken-feeds");
      await expect(link).toHaveText("View all broken feeds");
      await link.click();
    }
    await expect(page).toHaveURL(/\/manage-feeds\?tab=broken/);
    await expect(card(page, "Entry broken")).toBeVisible();
  });

  test("no entry while nothing is broken", async ({ app, page }) => {
    await app.open();
    if (app.isMobile) {
      await app.openSidebar();
      await expect(app.sidebar().getByTestId("feeds-broken")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("sidebar-broken-feeds")).toHaveCount(0);
    }
  });
});

test("re-test: a still-failing feed stays and explains why; a recovered feed is unmuted and leaves the list", async ({ app, page, request }) => {
  const flaky = track(insertBrokenFeed(app.userKey, { name: "Flaky", url: `${fixture}/broken/flaky.xml`, autoMuted: true, failures: 10, lastError: "Error: Fetch failed: 403", failingDays: 3 }));
  const forbidden = track(insertBrokenFeed(app.userKey, { name: "Forbidden", url: `${fixture}/broken/forbidden.xml`, failures: 2, lastError: "Error: Fetch failed: 500", failingDays: 1 }));
  await page.goto(PAGE);

  await app.activate(card(page, "Forbidden").getByTestId("broken-retest"));
  await expect(card(page, "Forbidden").getByTestId("broken-notice")).toHaveText("Still failing: Access denied – maybe login or bot protection");
  await expect(card(page, "Forbidden").getByTestId("broken-category")).toHaveText("Access denied – maybe login or bot protection");
  await expect(card(page, "Forbidden")).toContainText("3 failed attempts in a row");
  expect(brokenFeedState(forbidden.id)).toMatchObject({ exists: true, consecutiveFailureCount: 3 });
  expect(brokenFeedState(flaky.id)).toMatchObject({ autoMuted: true, consecutiveFailureCount: 10 });

  await request.get(`${fixture}/broken/heal`);
  await app.activate(card(page, "Flaky").getByTestId("broken-retest"));
  await expect(card(page, "Flaky")).toHaveCount(0);
  await expect(page.getByText("“Flaky” works again and is reactivated.")).toBeVisible();
  expect(brokenFeedState(flaky.id)).toMatchObject({ exists: true, autoMuted: false, consecutiveFailureCount: 0 });
  await expect(page.getByTestId("broken-feed")).toHaveCount(1);
});

test("'Re-test all' walks the list with progress and reports how many recovered", async ({ app, page, request }) => {
  const flaky = track(insertBrokenFeed(app.userKey, { name: "Flaky", url: `${fixture}/broken/flaky.xml`, autoMuted: true, failures: 10, failingDays: 3 }));
  const forbidden = track(insertBrokenFeed(app.userKey, { name: "Forbidden", url: `${fixture}/broken/forbidden.xml`, failures: 2, failingDays: 1 }));
  await request.get(`${fixture}/broken/heal`);
  await page.goto(PAGE);
  await expect(page.getByTestId("broken-feed")).toHaveCount(2);
  await app.activate(page.getByTestId("broken-retest-all"));
  await expect(page.getByText("1 work again, 1 still failing.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("broken-bulk-progress")).toHaveCount(0);
  await expect(page.getByTestId("broken-feed")).toHaveCount(1);
  expect(brokenFeedState(flaky.id)).toMatchObject({ autoMuted: false, consecutiveFailureCount: 0 });
  expect(brokenFeedState(forbidden.id)).toMatchObject({ exists: true, consecutiveFailureCount: 3 });
});

test("unmute gives a muted feed a clean slate and drops it from the list", async ({ app, page }) => {
  const muted = track(insertBrokenFeed(app.userKey, { name: "Muted one", url: "https://broken-unmute.e2e.test/feed.xml", autoMuted: true, failures: 10, failingDays: 2 }));
  await page.goto(PAGE);
  await app.activate(card(page, "Muted one").getByTestId("broken-unmute"));
  await expect(card(page, "Muted one")).toHaveCount(0);
  expect(brokenFeedState(muted.id)).toMatchObject({ autoMuted: false, consecutiveFailureCount: 0 });
});

test("remove asks first and deletes only the chosen feed", async ({ app, page }) => {
  const doomed = track(insertBrokenFeed(app.userKey, { name: "Doomed", url: "https://broken-doomed.e2e.test/feed.xml", failures: 5 }));
  const kept = track(insertBrokenFeed(app.userKey, { name: "Kept", url: "https://broken-kept.e2e.test/feed.xml", failures: 5 }));
  await page.goto(PAGE);

  await app.activate(card(page, "Doomed").getByTestId("broken-remove"));
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Remove “Doomed”?");
  await app.activate(dialog.getByRole("button", { name: "Cancel" }));
  expect(brokenFeedState(doomed.id).exists).toBe(true);

  await app.activate(card(page, "Doomed").getByTestId("broken-remove"));
  await app.activate(page.getByTestId("broken-remove-confirm"));
  await expect(card(page, "Doomed")).toHaveCount(0);
  await expect.poll(() => brokenFeedState(doomed.id).exists).toBe(false);
  expect(brokenFeedState(kept.id).exists).toBe(true);
});

test("remove all failing for more than 30 days: confirms with the count and spares younger streaks", async ({ app, page }) => {
  const stale1 = track(insertBrokenFeed(app.userKey, { name: "Stale one", url: "https://broken-s1.e2e.test/feed.xml", autoMuted: true, failures: 10, failingDays: 45 }));
  const stale2 = track(insertBrokenFeed(app.userKey, { name: "Stale two", url: "https://broken-s2.e2e.test/feed.xml", autoMuted: true, failures: 10, failingDays: 60 }));
  const young = track(insertBrokenFeed(app.userKey, { name: "Young", url: "https://broken-young.e2e.test/feed.xml", autoMuted: true, failures: 10, failingDays: 5 }));
  await page.goto(PAGE);

  const button = page.getByTestId("broken-remove-stale");
  await expect(button).toHaveText("Remove failing > 30 days (2)");
  await app.activate(button);
  const dialog = page.getByTestId("broken-remove-stale-confirm");
  await expect(dialog).toContainText("Remove 2 feeds?");
  await app.activate(dialog.getByRole("button", { name: "Cancel" }));
  expect(brokenFeedState(stale1.id).exists).toBe(true);

  await app.activate(button);
  await app.activate(dialog.getByRole("button", { name: "Remove 2 feeds" }));
  await expect(page.getByText("2 feeds removed.")).toBeVisible();
  await expect.poll(() => brokenFeedState(stale1.id).exists).toBe(false);
  expect(brokenFeedState(stale2.id).exists).toBe(false);
  expect(brokenFeedState(young.id).exists).toBe(true);
  await expect(page.getByTestId("broken-feed")).toHaveCount(1);
  await expect(button).toBeDisabled();
});

test("repair proposes the feed advertised by the site; accepting swaps the URL and revives the feed", async ({ app, page }) => {
  const moved = track(
    insertBrokenFeed(app.userKey, {
      name: "Moved",
      url: `${fixture}/broken/moved/old.xml`,
      htmlUrl: `${fixture}/broken/moved/`,
      autoMuted: true,
      failures: 10,
      failingDays: 7,
    }),
  );
  await page.goto(PAGE);
  await app.activate(card(page, "Moved").getByTestId("broken-repair"));
  const candidate = page.getByTestId("broken-repair-candidate");
  await expect(candidate).toHaveCount(1, { timeout: 30_000 });
  await expect(candidate).toContainText("Moved fixture");
  await expect(candidate).toContainText(`${fixture}/broken/moved/new.xml`);
  await app.activate(candidate.getByRole("button", { name: "Use this" }));
  await expect(card(page, "Moved")).toHaveCount(0, { timeout: 30_000 });
  expect(brokenFeedState(moved.id)).toMatchObject({ url: `${fixture}/broken/moved/new.xml`, autoMuted: false, consecutiveFailureCount: 0 });
});

test("edit opens the feed's settings dialog", async ({ app, page }) => {
  track(insertBrokenFeed(app.userKey, { name: "Editable", url: "https://broken-edit.e2e.test/feed.xml", failures: 2 }));
  await page.goto(PAGE);
  await app.activate(card(page, "Editable").getByTestId("broken-edit"));
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Editable");
});

// --- kaputt vs. inaktiv, blockiert vs. weg, archive ---------------------------------------------------

const inactiveCard = (page: import("@playwright/test").Page, name: string) =>
  page.getByTestId("inactive-feed").filter({ has: page.getByRole("heading", { name, exact: true }) });
const openInactive = async (app: { activate: (l: import("@playwright/test").Locator) => Promise<void> }, page: import("@playwright/test").Page) => {
  await app.activate(page.getByTestId("health-group-inactive"));
  await expect(page.getByTestId("inactive-feeds")).toBeVisible();
};

test("tells a blocked feed (403/429, bot protection) apart from a gone one (404/410)", async ({ app, page }) => {
  track(insertBrokenFeed(app.userKey, { name: "Bot wall", url: "https://broken-bot.e2e.test/feed.xml", failures: 3, lastError: "Error: Fetch failed: 429", failingDays: 2 }));
  track(insertBrokenFeed(app.userKey, { name: "Forbidden site", url: "https://broken-403.e2e.test/feed.xml", failures: 3, lastError: "Error: Fetch failed: 403", failingDays: 2 }));
  track(insertBrokenFeed(app.userKey, { name: "Vanished", url: "https://broken-410.e2e.test/feed.xml", failures: 3, lastError: "Error: Fetch failed: 410", failingDays: 2 }));
  track(insertBrokenFeed(app.userKey, { name: "Server down", url: "https://broken-500.e2e.test/feed.xml", failures: 3, lastError: "Error: Fetch failed: 500", failingDays: 2 }));
  await page.goto(PAGE);

  for (const name of ["Bot wall", "Forbidden site"]) {
    await expect(card(page, name).getByTestId("broken-kind")).toHaveText("Blocked");
    await expect(card(page, name).getByTestId("broken-kind")).toHaveAttribute("data-kind", "blocked");
    await expect(card(page, name).getByTestId("broken-kind-hint")).toContainText("may still work from another network");
  }
  await expect(card(page, "Vanished").getByTestId("broken-kind")).toHaveText("Gone");
  await expect(card(page, "Vanished").getByTestId("broken-kind-hint")).toContainText("no longer exists");
  await expect(card(page, "Server down").getByTestId("broken-kind")).toHaveCount(0);
  await expect(page.getByTestId("health-group-broken")).toHaveText("Broken (4)");
});

test("inactive group: feeds that fetch fine but stopped publishing, with the last item date; broken and fresh feeds are not in it", async ({ app, page }) => {
  track(insertInactiveFeed(app.userKey, { name: "Quiet since spring", url: "https://inactive-a.e2e.test/feed.xml", lastItemDaysAgo: 300 }));
  track(insertInactiveFeed(app.userKey, { name: "Quiet for years", url: "https://inactive-b.e2e.test/feed.xml", lastItemDaysAgo: 800 }));
  track(insertInactiveFeed(app.userKey, { name: "Never posted", url: "https://inactive-c.e2e.test/feed.xml", lastItemDaysAgo: null, createdDaysAgo: 400 }));
  track(insertInactiveFeed(app.userKey, { name: "Still active", url: "https://inactive-d.e2e.test/feed.xml", lastItemDaysAgo: 4 }));
  track(insertBrokenFeed(app.userKey, { name: "Broken and quiet", url: "https://inactive-e.e2e.test/feed.xml", failures: 3, lastError: "Error: Fetch failed: 500" }));
  await page.goto(PAGE);

  // the broken group does not contain the quiet feeds (and vice versa)
  await expect(page.getByTestId("broken-feed")).toHaveCount(1);
  await expect(card(page, "Broken and quiet")).toBeVisible();
  await expect(page.getByTestId("health-group-inactive")).toHaveText("Inactive (3)");

  await openInactive(app, page);
  const cards = page.getByTestId("inactive-feed");
  await expect(cards).toHaveCount(3);
  expect(await cards.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.feedName))).toEqual(["Quiet for years", "Never posted", "Quiet since spring"]);
  await expect(inactiveCard(page, "Quiet since spring").getByTestId("inactive-reason")).toContainText("Last item:");
  await expect(inactiveCard(page, "Quiet since spring").getByTestId("inactive-reason")).toContainText("300 days ago");
  await expect(inactiveCard(page, "Never posted").getByTestId("inactive-reason")).toContainText("Never published an item");
  await expect(inactiveCard(page, "Still active")).toHaveCount(0);
  await expect(page.getByTestId("inactive-feeds-summary")).toHaveText("3 inactive feeds");
  await expect(page.getByTestId("inactive-threshold")).toContainText("180 days");
});

test("a re-tested feed that works again but never publishes moves from broken to inactive (stale fixture)", async ({ app, page }) => {
  track(insertBrokenFeed(app.userKey, { name: "Silent revival", url: `${fixture}/broken/stale.xml`, failures: 3, lastError: "Error: Fetch failed: 500", failingDays: 2 }));
  await page.goto(PAGE);
  await app.activate(card(page, "Silent revival").getByTestId("broken-retest"));
  await expect(card(page, "Silent revival")).toHaveCount(0);
  await expect(page.getByText("“Silent revival” works again and is reactivated.")).toBeVisible();

  await openInactive(app, page);
  await expect(inactiveCard(page, "Silent revival")).toBeVisible();
  await expect(inactiveCard(page, "Silent revival").getByTestId("inactive-reason")).toContainText("400 days ago");
  await expect(inactiveCard(page, "Silent revival")).toContainText("1 article stored");
});

test("archive one inactive feed: it leaves the list, sidebar and counts but keeps its articles", async ({ app, page }) => {
  const quiet = track(insertInactiveFeed(app.userKey, { name: "Quiet archive me", url: "https://inactive-f.e2e.test/feed.xml", lastItemDaysAgo: 500 }));
  const before = feedArchiveState(quiet.id);
  expect(before).toMatchObject({ archived: false, articleCount: 1 });

  await app.open();
  const unreadBefore = await app.sidebarCount("All articles");
  await app.openSidebar();
  await expect(app.sidebar().getByRole("button", { name: /Quiet archive me/ }).first()).toBeVisible();

  await page.goto(PAGE);
  await openInactive(app, page);
  await app.activate(inactiveCard(page, "Quiet archive me").getByTestId("inactive-archive"));
  await expect(inactiveCard(page, "Quiet archive me")).toHaveCount(0);
  await expect(page.getByText("“Quiet archive me” archived.")).toBeVisible();
  await expect.poll(() => feedArchiveState(quiet.id).archived).toBe(true);
  // articles untouched, including their updatedAt
  expect(feedArchiveState(quiet.id)).toMatchObject({ articleCount: 1, articlesUpdatedAt: before.articlesUpdatedAt });

  await app.open();
  expect(await app.sidebarCount("All articles")).toBe(unreadBefore - 1);
  await app.openSidebar();
  await expect(app.sidebar().getByRole("button", { name: /Quiet archive me/ })).toHaveCount(0);

});

test("the toast's Undo restores a just-archived feed", async ({ app, page }) => {
  const quiet = track(insertInactiveFeed(app.userKey, { name: "Quiet undo me", url: "https://inactive-k.e2e.test/feed.xml", lastItemDaysAgo: 500 }));
  await page.goto(PAGE);
  await openInactive(app, page);
  await app.activate(inactiveCard(page, "Quiet undo me").getByTestId("inactive-archive"));
  await expect.poll(() => feedArchiveState(quiet.id).archived).toBe(true);
  await app.activate(page.getByRole("button", { name: "Undo" }));
  await expect.poll(() => feedArchiveState(quiet.id).archived).toBe(false);
  await expect(inactiveCard(page, "Quiet undo me")).toBeVisible();
});

test("an archived feed's articles stay reachable through its own view", async ({ app, page }) => {
  const quiet = track(insertInactiveFeed(app.userKey, { name: "Quiet but readable", url: "https://inactive-l.e2e.test/feed.xml", lastItemDaysAgo: 500, archived: true }));
  await page.goto("/manage-feeds");
  await app.activate(page.getByTestId("feed-filter-archived"));
  const row = page.getByTestId("archived-feed").filter({ hasText: "Quiet but readable" });
  await expect(row).toContainText("1 article kept");
  await app.activate(row.getByTestId("archived-open"));
  await expect(page).toHaveURL(new RegExp(`feed=${quiet.id}`));
  await expect(page.getByText("Quiet but readable last post").first()).toBeVisible();
});

test("'Archive all inactive' confirms with the count, archives only inactive feeds and leaves broken and active ones", async ({ app, page }) => {
  const a = track(insertInactiveFeed(app.userKey, { name: "Bulk quiet A", url: "https://inactive-g.e2e.test/feed.xml", lastItemDaysAgo: 250 }));
  const b = track(insertInactiveFeed(app.userKey, { name: "Bulk quiet B", url: "https://inactive-h.e2e.test/feed.xml", lastItemDaysAgo: 600 }));
  const active = track(insertInactiveFeed(app.userKey, { name: "Bulk active", url: "https://inactive-i.e2e.test/feed.xml", lastItemDaysAgo: 3 }));
  const broken = track(insertBrokenFeed(app.userKey, { name: "Bulk broken", url: "https://inactive-j.e2e.test/feed.xml", failures: 4 }));
  await page.goto(PAGE);
  await openInactive(app, page);

  const button = page.getByTestId("inactive-archive-all");
  await expect(button).toHaveText("Archive all inactive (2)");
  await app.activate(button);
  const dialog = page.getByTestId("inactive-archive-all-confirm");
  await expect(dialog).toContainText("Archive 2 feeds?");
  await expect(dialog).toContainText("more than 180 days");
  await app.activate(dialog.getByRole("button", { name: "Cancel" }));
  expect(feedArchiveState(a.id).archived).toBe(false);

  await app.activate(button);
  await app.activate(page.getByTestId("inactive-archive-all-confirm-button"));
  await expect(page.getByText("2 feeds archived.")).toBeVisible();
  await expect(page.getByTestId("inactive-feeds-empty")).toBeVisible();
  await expect.poll(() => feedArchiveState(a.id).archived).toBe(true);
  expect(feedArchiveState(b.id).archived).toBe(true);
  expect(feedArchiveState(active.id).archived).toBe(false);
  expect(brokenFeedState(broken.id).exists).toBe(true);
  expect(feedArchiveState(a.id).articleCount).toBe(1);
});

test("a broken feed can be archived too; the 'Archived' filter in Manage feeds lists it and 'Restore' brings it back", async ({ app, page }) => {
  const dead = track(insertBrokenFeed(app.userKey, { name: "Dead for good", url: "https://broken-archive.e2e.test/feed.xml", failures: 8, lastError: "Error: Fetch failed: 410", failingDays: 90 }));
  await page.goto(PAGE);
  await app.activate(card(page, "Dead for good").getByTestId("broken-archive"));
  await expect(card(page, "Dead for good")).toHaveCount(0);
  await expect.poll(() => feedArchiveState(dead.id).archived).toBe(true);
  expect(brokenFeedState(dead.id).exists).toBe(true); // archived, not deleted

  await page.goto("/manage-feeds");
  await app.activate(page.getByTestId("feed-filter-archived"));
  const row = page.getByTestId("archived-feed").filter({ hasText: "Dead for good" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Archived");
  await expect(page.getByTestId("feed-filter-archived")).toContainText("Archived (1)");

  await app.activate(row.getByTestId("archived-restore"));
  await expect(page.getByText("“Dead for good” restored.")).toBeVisible();
  await expect(page.getByTestId("archived-feeds-empty")).toBeVisible();
  await expect.poll(() => feedArchiveState(dead.id).archived).toBe(false);

  // back in the broken list (the failure bookkeeping was never touched)
  await page.goto(PAGE);
  await expect(card(page, "Dead for good")).toBeVisible();
});
