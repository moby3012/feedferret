import Database from "better-sqlite3";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../helpers/test";
import { manifest } from "../helpers/db";

/**
 * "From web page" selector quality gate: the suggester's preview must show
 * what the feed would contain, ask for review when quality is borderline, and
 * never present a menu/login list as a found feed. The listing pages come
 * from the local fixture server (e2e/fixtures/feed-server.mjs); the instance
 * "allow internal feed URLs" switch is enabled only for this spec and
 * restored afterwards (workers: 1, so no other spec observes it).
 */

const fixture = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT || 4010}`;
let restore: (() => void) | undefined;

test.beforeEach(() => {
  const db = new Database(manifest().dbPath);
  db.pragma("busy_timeout = 5000");
  const old = db.prepare('SELECT allowInternalFeedUrls FROM "GlobalSettings" WHERE id = ?').get("global") as { allowInternalFeedUrls: number } | undefined;
  if (old) db.prepare('UPDATE "GlobalSettings" SET allowInternalFeedUrls = 1 WHERE id = ?').run("global");
  else db.prepare('INSERT INTO "GlobalSettings" (id, updatedAt, allowInternalFeedUrls) VALUES (?, ?, 1)').run("global", new Date().toISOString());
  db.close();
  restore = () => {
    const db2 = new Database(manifest().dbPath);
    db2.pragma("busy_timeout = 5000");
    if (old) db2.prepare('UPDATE "GlobalSettings" SET allowInternalFeedUrls = ? WHERE id = ?').run(old.allowInternalFeedUrls, "global");
    else db2.prepare('DELETE FROM "GlobalSettings" WHERE id = ?').run("global");
    db2.close();
  };
});

test.afterEach(() => {
  restore?.();
  restore = undefined;
});

async function tapOrClick(target: Locator, isMobile: boolean) {
  if (isMobile) await target.tap();
  else await target.click();
}

async function suggestFrom(page: Page, isMobile: boolean, path: string) {
  await page.goto("/?addFeed=1");
  const dialog = page.getByRole("dialog", { name: "Add Feed" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await tapOrClick(dialog.getByRole("tab", { name: "More sources" }), isMobile);
  await tapOrClick(dialog.getByRole("button", { name: "From web page" }), isMobile);
  const input = dialog.getByPlaceholder("Page URL (e.g. a blog or listing page)");
  await input.fill(`${fixture}${path}`);
  await input.press("Enter");
  return dialog;
}

test("an undated listing is offered with a 'Review needed' label, reason and preview", async ({ app, page }) => {
  const dialog = await suggestFrom(page, app.isMobile, "/pages/undated");
  await expect(dialog.getByText("5 items found")).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId("page-feed-review-badge")).toHaveText("Review needed");
  await expect(dialog.getByTestId("page-feed-review-reasons")).toContainText("Most items have no date");
  const preview = dialog.getByTestId("page-feed-preview-item");
  await expect(preview).toHaveCount(4);
  await expect(preview.first()).toContainText("Lighthouse keepers and their long winters");
  await expect(preview.first()).toContainText("127.0.0.1/pages/posts/lighthouse-keepers-and-their-long-winters");
  await expect(preview.first()).toContainText("no date");
  await expect(dialog.getByRole("button", { name: "Create feed" })).toBeEnabled();
});

test("a dated listing passes the gate without a review label", async ({ app, page }) => {
  const dialog = await suggestFrom(page, app.isMobile, "/pages/dated");
  await expect(dialog.getByText("5 items found")).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText("Preview looks plausible")).toBeVisible();
  await expect(dialog.getByTestId("page-feed-review-badge")).toHaveCount(0);
  await expect(dialog.getByTestId("page-feed-preview-item").first()).toContainText("Nov 1, 2026");
});

test("a page with only login/social/map links is not presented as a found feed", async ({ app, page }) => {
  const dialog = await suggestFrom(page, app.isMobile, "/pages/menu-only");
  await expect(dialog.getByText("No structured items found")).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId("page-feed-rejected")).toContainText("only contained menu, login, map or placeholder links");
  await expect(dialog.getByRole("button", { name: "Create feed" })).toHaveCount(0);
});
