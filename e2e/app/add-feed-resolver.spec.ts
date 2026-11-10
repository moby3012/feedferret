import type { Page } from "@playwright/test";
import { test, expect } from "../helpers/test";

/**
 * Smart source → feed resolution in the Add-Feed dialog. Everything asserted
 * here is deterministic (platform rules + topic feeds are built in-process), so
 * the suite needs no network.
 */

const INPUT = "Feed or site URL, @handle, or topic";

async function openAddFeed(app: { page: Page }, query = "addFeed=1") {
  await app.page.goto(`/?${query}`);
  const dialog = app.page.getByRole("dialog", { name: "Add Feed" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  return dialog;
}

test("a plain phrase offers news & search feeds to pick from", async ({ app, page }) => {
  const dialog = await openAddFeed(app);
  const input = dialog.getByPlaceholder(INPUT);
  await input.fill("local first software");
  await input.press("Enter");

  await expect(dialog.getByText("News & search feeds for this topic — pick one")).toBeVisible();
  for (const name of ["Google News", "Bing News", "Hacker News", "arXiv"]) {
    await expect(dialog.getByText(new RegExp(`^${name} · “local first software”`))).toBeVisible();
  }
  // Locale-aware Google News feed (browser locale is en-US in the harness).
  await expect(dialog.getByTitle(/news\.google\.com\/rss\/search\?q=local%20first%20software&hl=en-US&gl=US/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add", exact: true })).toHaveCount(4);
});

test("a GitHub repo URL resolves to releases / commits / tags without scraping", async ({ app, page }) => {
  const dialog = await openAddFeed(app);
  const input = dialog.getByPlaceholder(INPUT);
  await input.fill("https://github.com/vercel/next.js");
  await input.press("Enter");

  await expect(dialog.getByText("Found feeds")).toBeVisible();
  await expect(dialog.getByText("GitHub · vercel/next.js")).toHaveCount(3);
  for (const kind of ["Releases", "Commits", "Tags"]) await expect(dialog.getByText(kind, { exact: true })).toBeVisible();
  await expect(dialog.getByTitle("https://github.com/vercel/next.js/releases.atom")).toBeVisible();
});

test("share-target / bookmarklet link lands on By URL pre-filled; discovery runs on user action", async ({ app, page }) => {
  const dialog = await openAddFeed(app, `sharedUrl=${encodeURIComponent("https://github.com/rust-lang/rust")}`);
  const input = dialog.getByPlaceholder(INPUT);
  await expect(input).toHaveValue("https://github.com/rust-lang/rust");
  await expect(dialog.getByText("Found feeds")).toHaveCount(0); // no auto-probe from a link
  await input.press("Enter");
  await expect(dialog.getByText("Found feeds")).toBeVisible();
  await expect(dialog.getByTitle("https://github.com/rust-lang/rust/releases.atom")).toBeVisible();
});

test("the dialog and settings expose a draggable bookmarklet that targets the share route", async ({ app, page }) => {
  const dialog = await openAddFeed(app);
  const link = dialog.getByRole("link", { name: "Subscribe in FeedFerret" });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^javascript:/);
  expect(href).toContain(`${new URL(page.url()).origin}/?sharedUrl=`);

  await app.openSettings("Account");
  const settingsLink = page.getByRole("link", { name: "Subscribe in FeedFerret" });
  await expect(settingsLink).toHaveAttribute("href", /^javascript:.*sharedUrl=/);
});
