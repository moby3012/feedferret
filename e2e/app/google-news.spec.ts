import Database from "better-sqlite3";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../helpers/test";
import { manifest } from "../helpers/db";

/**
 * G1: Google News keyword feeds. The app's Google News origin points at the
 * fixture server's fake Google (playwright.config.ts → e2e/fixtures/
 * feed-server.mjs), so search, preview, subscribe and redirect-link
 * resolution all run offline. Every feed a test creates is deleted again
 * (shared seeded DB).
 */

type FeedRow = { id: string; name: string; url: string };
type ArticleRow = { title: string; link: string; author: string | null };

function withDb<T>(fn: (db: InstanceType<typeof Database>) => T): T {
  const db = new Database(manifest().dbPath);
  db.pragma("busy_timeout = 5000");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const googleFeeds = (userId: string) =>
  withDb((db) => db.prepare(`SELECT id, name, url FROM "Feed" WHERE userId = ? AND url LIKE '%/rss/search?%'`).all(userId) as FeedRow[]);
const feedArticles = (feedId: string) =>
  withDb((db) => db.prepare(`SELECT title, link, author FROM "Article" WHERE feedId = ? ORDER BY publishedAt DESC`).all(feedId) as ArticleRow[]);
const deleteGoogleFeeds = (userId: string) =>
  withDb((db) => {
    db.pragma("foreign_keys = ON");
    db.prepare(`DELETE FROM "Feed" WHERE userId = ? AND url LIKE '%/rss/search?%'`).run(userId);
  });

async function tapOrClick(target: Locator, isMobile: boolean) {
  if (isMobile) await target.tap();
  else await target.click();
}

async function pick(page: Page, isMobile: boolean, combobox: Locator, option: string) {
  await tapOrClick(combobox, isMobile);
  await tapOrClick(page.getByRole("option", { name: option, exact: true }), isMobile);
}

async function openGoogleNews(page: Page, isMobile: boolean) {
  await page.goto("/?addFeed=1");
  const dialog = page.getByRole("dialog", { name: "Add Feed" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await tapOrClick(dialog.getByRole("tab", { name: "More sources" }), isMobile);
  // Google News is the first (default) source.
  await expect(dialog.getByRole("button", { name: "Google News" })).toHaveAttribute("aria-pressed", "true");
  return dialog;
}

test.describe("Google News keyword feeds", () => {
  test.beforeEach(({ app }) => deleteGoogleFeeds(app.user.userId));
  test.afterEach(({ app }) => deleteGoogleFeeds(app.user.userId));

  test("keyword → live preview → subscribe; links resolve to publisher URLs", async ({ app, page }) => {
    const dialog = await openGoogleNews(page, app.isMobile);

    const keywords = dialog.getByLabel("Keywords");
    await keywords.fill("Solarstrom");
    const preview = dialog.getByTestId("google-news-preview");
    await expect(preview.getByText("3 results")).toBeVisible({ timeout: 20_000 });
    await expect(preview.getByText("Google News: Solarstrom")).toBeVisible();
    // Titles arrive without the " - Publisher" suffix; the publisher is shown below.
    await expect(preview.getByText("Solarstrom: Meldung 1", { exact: true })).toBeVisible();
    await expect(preview.getByText(/^Tagesschau · /)).toBeVisible();

    // Language default follows the UI locale (en → US edition).
    await expect(dialog.getByRole("combobox", { name: "Language & region" })).toHaveText("US · English");
    await pick(page, app.isMobile, dialog.getByRole("combobox", { name: "Time window" }), "Past 7 days");
    await expect(preview.getByText("3 results")).toBeVisible({ timeout: 20_000 });

    await tapOrClick(preview.getByRole("button", { name: "Subscribe" }), app.isMobile);
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText(/Google News: Solarstrom/).first()).toBeVisible();

    const [feed] = googleFeeds(app.user.userId);
    expect(feed.name).toBe("Google News: Solarstrom");
    const url = new URL(feed.url);
    expect(url.searchParams.get("q")).toBe("Solarstrom when:7d");
    expect(url.searchParams.get("ceid")).toBe("US:en");
    const articles = feedArticles(feed.id);
    expect(articles).toHaveLength(3);
    expect(articles[0]).toEqual({
      title: "Solarstrom: Meldung 1",
      link: "https://news-publisher.example/solarstrom/meldung-1",
      author: "Tagesschau",
    });
    for (const a of articles) expect(a.link).toMatch(/^https:\/\/news-publisher\.example\//);

    // Subscribing to the same search twice is refused with a clear message.
    const again = await openGoogleNews(page, app.isMobile);
    await again.getByLabel("Keywords").fill("Solarstrom");
    await pick(page, app.isMobile, again.getByRole("combobox", { name: "Time window" }), "Past 7 days");
    await tapOrClick(again.getByTestId("google-news-preview").getByRole("button", { name: "Subscribe" }), app.isMobile);
    await expect(again.getByRole("alert")).toHaveText("You already follow this search.");
    expect(googleFeeds(app.user.userId)).toHaveLength(1);
  });

  test("the topic search offers 'Customize' into the keyword panel; the query stays editable in feed settings", async ({ app, page }) => {
    await page.goto("/?addFeed=1");
    const dialog = page.getByRole("dialog", { name: "Add Feed" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const input = dialog.getByPlaceholder("Feed or site URL, @handle, or topic");
    await input.fill("Wasserstoff");
    await input.press("Enter");
    await tapOrClick(dialog.getByRole("button", { name: "Customize" }), app.isMobile);
    await expect(dialog.getByLabel("Keywords")).toHaveValue("Wasserstoff");
    const preview = dialog.getByTestId("google-news-preview");
    await expect(preview.getByText("3 results")).toBeVisible({ timeout: 20_000 });
    await tapOrClick(preview.getByRole("button", { name: "Subscribe" }), app.isMobile);
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const [feed] = googleFeeds(app.user.userId);
    await page.goto(`/manage-feeds?feedId=${feed.id}`);
    const row = page.locator(`#feed-row-${feed.id}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await tapOrClick(row.getByTitle("Settings"), app.isMobile);
    const settings = page.getByRole("dialog", { name: "Google News: Wasserstoff" });
    await expect(settings).toBeVisible();
    if (app.isMobile) await pick(page, true, settings.getByRole("combobox").first(), "Fetch Options");
    else await settings.getByRole("tab", { name: "Fetch Options" }).click();

    const editor = settings.getByRole("region", { name: "Google News search" });
    const keywords = editor.getByLabel("Keywords");
    await expect(keywords).toHaveValue("Wasserstoff");
    await keywords.fill("Wasserstoff -Auto");
    await expect(editor.getByTestId("google-news-preview").getByText("3 results")).toBeVisible({ timeout: 20_000 });
    await tapOrClick(editor.getByRole("button", { name: "Save search" }), app.isMobile);
    await expect(editor.getByText("Search updated.")).toBeVisible({ timeout: 30_000 });

    const [updated] = googleFeeds(app.user.userId);
    expect(updated.id).toBe(feed.id);
    expect(new URL(updated.url).searchParams.get("q")).toBe("Wasserstoff -Auto");
    // The auto-generated name follows the query.
    expect(updated.name).toBe("Google News: Wasserstoff -Auto");
  });
});
