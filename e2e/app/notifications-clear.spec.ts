import { autoMuteFirstFeed, deleteNotificationsInDb, feedMuteState, notificationCountInDb, seedNotifications, unmuteFeedInDb } from "../helpers/db";
import { test, expect } from "../helpers/test";

/**
 * Sidebar bell popover (desktop): per-item dismiss + "Clear all" (with a short
 * confirm). Clearing only deletes THIS user's notification rows — the feed's
 * auto-mute / error state is untouched and nothing re-appears on reload.
 * The popover must also be the topmost layer (stacking regression guard).
 */
test.use({ viewport: { width: 2000, height: 950 } });

test.describe("notifications popover", () => {
  let mutedFeedId = "";
  test.beforeEach(({ app }) => {
    test.skip(app.isMobile, "desktop bell popover (mobile uses the Feeds header sheet)");
    deleteNotificationsInDb("desktop");
    deleteNotificationsInDb("mobile");
    mutedFeedId = autoMuteFirstFeed("desktop");
  });
  test.afterEach(({ app }) => {
    if (app.isMobile) return;
    deleteNotificationsInDb("desktop");
    deleteNotificationsInDb("mobile");
    if (mutedFeedId) unmuteFeedInDb(mutedFeedId);
  });

  test("dismiss one, clear all (confirm), feed stays muted, other user untouched, stays gone after reload", async ({ app, page }) => {
    seedNotifications("desktop", 3);
    seedNotifications("mobile", 2);
    await app.open();
    const bell = page.getByRole("button", { name: "Notifications" });
    await bell.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const items = menu.getByTestId("notification-item");
    await expect(items).toHaveCount(3);

    // Topmost at its centre: nothing from the list / reader covers the popover.
    const topmost = await items.first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)[0];
      return !!hit && el.contains(hit);
    });
    expect(topmost).toBe(true);

    // Per-item dismiss: that row goes, the menu stays open.
    await items.first().getByTestId("notification-dismiss").click();
    await expect(items).toHaveCount(2);
    await expect(menu).toBeVisible();
    await expect.poll(() => notificationCountInDb("desktop")).toBe(2);

    // Clear all: asks first; cancel keeps everything.
    await menu.getByTestId("notifications-clear-all").click();
    const confirm = page.getByTestId("notifications-clear-confirm");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    expect(notificationCountInDb("desktop")).toBe(2);

    await bell.click();
    await page.getByRole("menu").getByTestId("notifications-clear-all").click();
    await page.getByTestId("notifications-clear-confirm").getByRole("button", { name: "Delete all" }).click();
    await expect.poll(() => notificationCountInDb("desktop")).toBe(0);

    // Scoped to the session user; feed state untouched.
    expect(notificationCountInDb("mobile")).toBe(2);
    expect(feedMuteState(mutedFeedId)).toMatchObject({ autoMuted: true, consecutiveFailureCount: 10, lastError: "boom" });

    // Empty state; nothing comes back after a reload.
    await page.reload();
    await app.navReady();
    await page.getByRole("button", { name: "Notifications" }).click();
    await expect(page.getByRole("menu").getByText("No notifications")).toBeVisible();
    await expect(page.getByRole("menu").getByTestId("notifications-clear-all")).toHaveCount(0);
    expect(feedMuteState(mutedFeedId).autoMuted).toBe(true);
  });
});
