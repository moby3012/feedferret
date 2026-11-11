import Database from "better-sqlite3";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../helpers/test";
import { manifest } from "../helpers/db";

/**
 * P-PLAT software adapters: a Discourse forum in a sub-folder that does not
 * advertise its feed anywhere (no <link rel=alternate>, no RSS anchor) is
 * recognised from its generator meta, its native `latest.rss` is verified
 * and offered — and the UI says where the feed comes from ("Discourse forum").
 * Served by the local fixture server (plain http on 127.0.0.1), so the
 * instance "allow internal feed URLs" switch is enabled for this spec only.
 */

const host = `127.0.0.1:${process.env.E2E_FIXTURE_PORT || 4010}`;
const FORUM = `http://${host}/disc/forum/`;
const FEED_URL = `http://${host}/disc/forum/latest.rss`;
let restore: (() => void) | undefined;

function openDb() {
  const db = new Database(manifest().dbPath);
  db.pragma("busy_timeout = 5000");
  return db;
}

test.beforeEach(() => {
  const db = openDb();
  const old = db.prepare('SELECT allowInternalFeedUrls FROM "GlobalSettings" WHERE id = ?').get("global") as { allowInternalFeedUrls: number } | undefined;
  if (old) db.prepare('UPDATE "GlobalSettings" SET allowInternalFeedUrls = 1 WHERE id = ?').run("global");
  else db.prepare('INSERT INTO "GlobalSettings" (id, updatedAt, allowInternalFeedUrls) VALUES (?, ?, 1)').run("global", new Date().toISOString());
  db.close();
  restore = () => {
    const db2 = openDb();
    if (old) db2.prepare('UPDATE "GlobalSettings" SET allowInternalFeedUrls = ? WHERE id = ?').run(old.allowInternalFeedUrls, "global");
    else db2.prepare('DELETE FROM "GlobalSettings" WHERE id = ?').run("global");
    db2.close();
  };
});

test.afterEach(({ app }) => {
  restore?.();
  restore = undefined;
  const db = openDb();
  try {
    const feedIds = db.prepare('SELECT id FROM "Feed" WHERE url = ? AND userId = ?').all(FEED_URL, app.user.userId) as { id: string }[];
    for (const { id } of feedIds) {
      db.prepare('DELETE FROM "Article" WHERE feedId = ?').run(id);
      db.prepare('DELETE FROM "Feed" WHERE id = ?').run(id);
    }
  } finally {
    db.close();
  }
});

async function tapOrClick(target: Locator, isMobile: boolean) {
  if (isMobile) await target.tap();
  else await target.click();
}

async function openAddFeed(page: Page) {
  await page.goto("/?addFeed=1");
  const dialog = page.getByRole("dialog", { name: "Add Feed" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  return dialog;
}

test("By URL: a Discourse forum without any feed link offers its native latest.rss, labelled 'Discourse forum'", async ({ app, page }) => {
  const dialog = await openAddFeed(page);
  const input = dialog.getByPlaceholder("Feed or site URL, @handle, or topic");
  await input.fill(FORUM);
  await input.press("Enter");

  await expect(dialog.getByText("Found feeds")).toBeVisible({ timeout: 30_000 });
  const row = dialog.getByTestId("discovered-feed");
  await expect(row).toHaveCount(1);
  await expect(row.getByTitle(FEED_URL)).toHaveText("Harbour Forum - Latest topics");
  await expect(row.getByTestId("discovered-feed-source")).toHaveText("Discourse forum");
  await expect(row.getByText("Latest", { exact: true })).toBeVisible();

  await tapOrClick(row.getByRole("button", { name: "Add", exact: true }), app.isMobile);
  await expect(page.getByRole("dialog", { name: "Add Feed" })).toBeHidden({ timeout: 30_000 });
  const db = openDb();
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM "Feed" WHERE url = ? AND userId = ?').get(FEED_URL, app.user.userId)).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});

test("From web page: 'Feed found' names the source of the candidate", async ({ app, page }) => {
  const dialog = await openAddFeed(page);
  await tapOrClick(dialog.getByRole("tab", { name: "More sources" }), app.isMobile);
  await tapOrClick(dialog.getByRole("button", { name: "From web page" }), app.isMobile);
  const input = dialog.getByPlaceholder("Page URL (e.g. a blog or listing page)");
  await input.fill(FORUM);
  await input.press("Enter");

  const found = dialog.getByTestId("page-feed-found");
  await expect(found).toContainText("Feed found", { timeout: 30_000 });
  const item = found.getByTestId("page-feed-found-item");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Harbour Forum - Latest topics");
  await expect(item.getByTestId("page-feed-found-source")).toContainText("Discourse forum");
});
