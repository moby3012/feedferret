import { test, expect } from "../helpers/test";
import { articleFlags, unreadCountInDb } from "../helpers/db";

/**
 * Read / star / read-later toggles: UI state, sidebar counts and the value the
 * server persisted (checked straight in the seeded SQLite file). Every test
 * starts from the pristine seed (fixture `app` resets the flags).
 *
 * Seed facts used here (e2e/fixtures/data.mjs): #001 unread, not starred, not
 * read-later; #004 is starred; #006 is read-later; all of #001-#012 unread.
 */

test("star toggle: icon, Starred badge and DB agree", async ({ app }) => {
  await app.open();
  const before = await app.sidebarCount("Starred");
  expect(before).toBe(app.user.counts.starred);

  await app.toggle(1, "star");
  await app.expectRow(1, { starred: true });
  await expect.poll(() => articleFlags(app.articleId(1)).isStarred).toBe(true);
  await expect.poll(() => app.sidebarCount("Starred")).toBe(before + 1);

  await app.toggle(1, "star");
  await app.expectRow(1, { starred: false });
  await expect.poll(() => articleFlags(app.articleId(1)).isStarred).toBe(false);
  await expect.poll(() => app.sidebarCount("Starred")).toBe(before);
});

test("read-later toggle: icon, Read later badge and DB agree", async ({ app }) => {
  await app.open();
  const before = await app.sidebarCount("Read later");
  expect(before).toBe(app.user.counts.readLater);

  await app.toggle(1, "later");
  await app.expectRow(1, { later: true });
  await expect.poll(() => articleFlags(app.articleId(1)).isReadLater).toBe(true);
  await expect.poll(() => app.sidebarCount("Read later")).toBe(before + 1);

  await app.toggle(1, "later");
  await app.expectRow(1, { later: false });
  await expect.poll(() => articleFlags(app.articleId(1)).isReadLater).toBe(false);
  await expect.poll(() => app.sidebarCount("Read later")).toBe(before);
});

test("mark read / unread from the row updates icon, All-articles badge and DB", async ({ app }) => {
  await app.open();
  const before = await app.sidebarCount("All articles");
  expect(before).toBe(app.user.counts.unread);

  await app.toggle(2, "read");
  await app.expectRow(2, { read: true });
  await expect.poll(() => articleFlags(app.articleId(2)).isRead).toBe(true);
  await expect.poll(() => app.sidebarCount("All articles")).toBe(before - 1);

  await app.toggle(2, "read");
  await app.expectRow(2, { read: false });
  await expect.poll(() => articleFlags(app.articleId(2)).isRead).toBe(false);
  await expect.poll(() => app.sidebarCount("All articles")).toBe(before);
});

test("opening an article marks it read (instant default) and reader toggles reflect in the list", async ({ app, page }) => {
  await app.open();
  const before = await app.sidebarCount("All articles");
  await app.activate(app.row(3));
  const reader = page.locator("article").filter({ hasText: "(#003)" });
  await expect(reader).toBeVisible();
  await expect.poll(() => articleFlags(app.articleId(3)).isRead, { timeout: 10_000 }).toBe(true);

  // Reader toolbar: star + mark-unread.
  await app.activate(app.reader().getByRole("button", { name: "Star", exact: true }));
  await expect.poll(() => articleFlags(app.articleId(3)).isStarred).toBe(true);
  await app.activate(app.reader().getByRole("button", { name: "Mark as unread" }));
  await expect.poll(() => articleFlags(app.articleId(3)).isRead).toBe(false);
  // Mobile: the tab bar (Feeds tab) is hidden in the reader, so close the reader first.
  await app.activate(page.getByRole("button", { name: /^(Back to list|Back)$/ }).first());
  await expect.poll(() => app.sidebarCount("All articles")).toBe(before);
});

test("mark all as read empties unread counts and persists", async ({ app, page }) => {
  await app.open();
  await app.markAllRead();
  // A confirmation may be shown; confirm if present (current behaviour documented in testing.md).
  const confirm = page.getByRole("alertdialog").getByRole("button", { name: /mark all|confirm|yes|ok/i });
  if (await confirm.isVisible().catch(() => false)) await app.activate(confirm.first());

  await expect.poll(() => unreadCountInDb(app.userKey), { timeout: 15_000 }).toBe(0);
  await expect.poll(() => app.sidebarCount("All articles"), { timeout: 15_000 }).toBe(0);
});
