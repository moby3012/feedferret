import Database from "better-sqlite3";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../helpers/test";
import { manifest } from "../helpers/db";
import { setAiProvider } from "../helpers/briefing-db";

/**
 * Discovery-first add-feed (AI-FEED-DIAGNOSIS D-P0-1/2): a page address typed
 * into any add path finds the site's real feed — linked only by an RSS icon
 * in the footer of a page with a large <head> — and offers it with one click
 * instead of failing ("Invalid feed URL") or scraping/asking the AI.
 *
 * The site is the local fixture server (plain http on 127.0.0.1), so most
 * tests type the address with an explicit `http://` plus copy/paste junk. A
 * BARE address is tried over https first; against this plain-http server
 * that is a TLS failure (wrong version number), which must NOT be "fixed" by
 * falling back to http (MITM downgrade) — the last test pins that.
 * Bare domain → https → "Feed found" is covered offline by unit tests
 * (tests/lib/discovery-fixtures.test.ts). The instance "allow internal feed
 * URLs" switch is enabled only for this spec and restored afterwards.
 */

const host = `127.0.0.1:${process.env.E2E_FIXTURE_PORT || 4010}`;
const BARE_SITE = `${host}/disc/site`;
// Explicit scheme, pasted with surrounding junk (quotes, trailing period) — normalised by the server.
const SITE = `"http://${host}/disc/site".`;
const FEED_URL = `http://${host}/disc/site/feed.xml`;
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
  // Specs share one DB: drop the feed a test subscribed to (articles cascade).
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

async function openWebPageTab(page: Page, isMobile: boolean) {
  await page.goto("/?addFeed=1");
  const dialog = page.getByRole("dialog", { name: "Add Feed" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await tapOrClick(dialog.getByRole("tab", { name: "More sources" }), isMobile);
  await tapOrClick(dialog.getByRole("button", { name: "From web page" }), isMobile);
  return dialog;
}

test("From web page: a pasted page address finds the footer-linked feed first (Feed found → one-click subscribe)", async ({ app, page }) => {
  const dialog = await openWebPageTab(page, app.isMobile);
  const input = dialog.getByPlaceholder("Page URL (e.g. a blog or listing page)");
  await input.fill(SITE);
  await input.press("Enter");

  const found = dialog.getByTestId("page-feed-found");
  await expect(found).toContainText("Feed found", { timeout: 30_000 });
  const item = found.getByTestId("page-feed-found-item");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Harbour Notes");
  await expect(item.getByTitle(FEED_URL)).toBeVisible();
  // Scraping stays available as an explicit alternative.
  await expect(found.getByRole("button", { name: "Build from page anyway" })).toBeVisible();

  await tapOrClick(item.getByRole("button", { name: "Subscribe" }), app.isMobile);
  await expect(page.getByRole("dialog", { name: "Add Feed" })).toBeHidden({ timeout: 30_000 });
  const db = openDb();
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM "Feed" WHERE url = ? AND userId = ?').get(FEED_URL, app.user.userId)).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});

test("From web page: 'Build from page anyway' skips discovery and shows the item list", async ({ app, page }) => {
  const dialog = await openWebPageTab(page, app.isMobile);
  const input = dialog.getByPlaceholder("Page URL (e.g. a blog or listing page)");
  await input.fill(SITE);
  await input.press("Enter");
  await expect(dialog.getByTestId("page-feed-found")).toBeVisible({ timeout: 30_000 });
  await tapOrClick(dialog.getByRole("button", { name: "Build from page anyway" }), app.isMobile);
  await expect(dialog.getByText("4 items found")).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId("page-feed-found")).toHaveCount(0);
});

test("Let AI set this up: a page that already has a feed gets it offered, without an AI call", async ({ app, page }) => {
  setAiProvider(app.userKey, "fake", "fake");
  try {
    const dialog = await openWebPageTab(page, app.isMobile);
    const input = dialog.getByPlaceholder("Page URL (e.g. a blog or listing page)");
    await input.fill(SITE);
    await tapOrClick(dialog.getByRole("button", { name: /Let AI set this up/ }), app.isMobile);
    const found = dialog.getByTestId("page-feed-found");
    await expect(found).toContainText("Feed found", { timeout: 30_000 });
    await expect(found.getByTestId("page-feed-found-item")).toContainText("Harbour Notes");
    await expect(found.getByRole("button", { name: "Let AI set it up anyway" })).toBeVisible();
    const db = openDb();
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM "AiUsage" WHERE userId = ?').get(app.user.userId)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  } finally {
    setAiProvider(app.userKey, null, null);
  }
});

test("By URL → Add direct URL with a web-page address falls back to discovery", async ({ app, page }) => {
  await page.goto("/?addFeed=1");
  const dialog = page.getByRole("dialog", { name: "Add Feed" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByPlaceholder("Feed or site URL, @handle, or topic").fill(SITE);
  await tapOrClick(dialog.getByRole("button", { name: "Add direct URL" }), app.isMobile);

  await expect(dialog.getByTestId("add-feed-not-a-feed")).toContainText("That address is a web page, not a feed.", { timeout: 30_000 });
  await expect(dialog.getByText("Found feeds")).toBeVisible();
  await expect(dialog.getByTitle(FEED_URL)).toBeVisible();
});

test("an input that is not an address gets a readable, localised error (no 'Invalid feed URL')", async ({ app, page }) => {
  const dialog = await openWebPageTab(page, app.isMobile);
  const input = dialog.getByPlaceholder("Page URL (e.g. a blog or listing page)");
  await input.fill("not an address");
  await input.press("Enter");
  await expect(dialog.getByText("That doesn't look like a web address (e.g. example.com).")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Invalid feed URL")).toHaveCount(0);
});

test("a bare address whose https fails with a TLS error is NOT downgraded to http; the user gets a certificate error", async ({ app, page }) => {
  const dialog = await openWebPageTab(page, app.isMobile);
  const input = dialog.getByPlaceholder("Page URL (e.g. a blog or listing page)");
  await input.fill(BARE_SITE);
  await input.press("Enter");
  await expect(dialog.getByText(/The secure \(HTTPS\) connection to this site failed \(certificate error\)/)).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId("page-feed-found")).toHaveCount(0);
  await expect(dialog.getByTestId("page-feed-candidate")).toHaveCount(0);

  // Same for "Add direct URL": no feed is created over plain http.
  await page.goto("/?addFeed=1");
  const urlDialog = page.getByRole("dialog", { name: "Add Feed" });
  await expect(urlDialog).toBeVisible({ timeout: 30_000 });
  await urlDialog.getByPlaceholder("Feed or site URL, @handle, or topic").fill(`${host}/disc/site/feed.xml`);
  await tapOrClick(urlDialog.getByRole("button", { name: "Add direct URL" }), app.isMobile);
  await expect(page.getByText(/certificate error/).first()).toBeVisible({ timeout: 30_000 });
  const db = openDb();
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM "Feed" WHERE url LIKE ? AND userId = ?').get(`%${host}/disc/site/feed.xml`, app.user.userId)).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
