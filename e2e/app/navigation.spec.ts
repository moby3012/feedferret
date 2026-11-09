import { test, expect } from "../helpers/test";

/**
 * Characterization of CURRENT navigation behaviour (desktop 1280x800 and
 * mobile 390x844 touch). Selection / reader state lives only in React state:
 * the URL stays "/" and history is not used. Tests marked `fixme` describe
 * the desired behaviour from the UX audit and are enabled when URL-based
 * navigation lands (.pm/audit-ux.md P1-03).
 */

test("app opens: list visible with seeded articles and sidebar", async ({ app, page }) => {
  await app.open();
  await expect(page.getByRole("heading", { level: 2, name: "All articles" })).toBeVisible();
  await expect(app.row(1)).toBeVisible();
  await expect(app.row(2)).toBeVisible();
  // Feed list: always visible on desktop, a sheet on mobile.
  await app.openSidebar();
  await expect(app.sidebar().getByRole("button", { name: /^All articles\s*\d+$/ })).toBeVisible();
  await expect(app.sidebar().getByRole("button", { name: /^Solo Blog\s*\d+$/ })).toBeVisible();
  await expect(app.sidebar().getByRole("button", { name: "Expand Tech" })).toBeVisible();
  await app.closeSidebar();
});

test("selecting a feed narrows the list to that feed", async ({ app, page }) => {
  await app.open();
  await app.selectSidebar(/^Solo Blog\s*\d+$/);
  await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
  // Article #008 belongs to Solo Blog, #001 (Hacker Dispatch) must be gone.
  await expect(app.row(8)).toBeVisible();
  await expect(app.row(1)).toHaveCount(0);
  const labels = await page.locator('[role="button"][aria-label*="—"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute("aria-label") ?? ""),
  );
  expect(labels.length).toBeGreaterThan(5);
  for (const l of labels) expect(l.endsWith("— Solo Blog")).toBe(true);
});

test("opening an article shows title and content in the reader", async ({ app, page }) => {
  await app.open();
  await app.activate(app.row(1));
  const reader = page.locator("article").filter({ hasText: app.user.firstArticleTitle });
  await expect(reader).toBeVisible();
  await expect(reader.getByRole("heading", { level: 1, name: app.user.firstArticleTitle })).toBeVisible();
  await expect(reader).toContainText(app.user.firstArticleBodyStart.slice(0, 25));
  // Current behaviour: opening a reader does not touch the URL or history (P1-03).
  expect(new URL(page.url()).pathname).toBe("/");
});

test("reader renders images and code blocks", async ({ app, page }) => {
  await app.open();
  await page.getByRole("button", { name: new RegExp(app.user.sample.code.replace(/[()#]/g, "\\$&")) }).first().scrollIntoViewIfNeeded();
  await app.activate(page.getByRole("button", { name: new RegExp(app.user.sample.code.replace(/[()#]/g, "\\$&")) }).first());
  const reader = page.locator("article").filter({ hasText: app.user.sample.code });
  await expect(reader.locator("pre code")).toBeVisible();
});

test("close reader returns to the list", async ({ app, page }) => {
  await app.open();
  await app.activate(app.row(1));
  const reader = page.locator("article").filter({ hasText: app.user.firstArticleTitle });
  await expect(reader).toBeVisible();
  await app.activate(page.getByRole("button", { name: /^(Back to list|Back)$/ }).first());
  await expect(reader).toBeHidden();
  await expect(app.row(2)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

test.fixme("browser/Android back from the reader returns to the list, not out of the app (P1-03)", async ({ app, page }) => {
  // Known-bad today: no history entry is pushed when the reader opens, so
  // history.back() leaves the app (to /login or the previous site).
  await app.open();
  await app.activate(app.row(1));
  await expect(page.locator("article").filter({ hasText: app.user.firstArticleTitle })).toBeVisible();
  await page.goBack();
  expect(new URL(page.url()).pathname).toBe("/"); // still inside the app
  await expect(page.locator("article").filter({ hasText: app.user.firstArticleTitle })).toBeHidden();
  await expect(app.row(2)).toBeVisible();
});

test.fixme("reload restores selected feed and open article (P1-03)", async ({ app, page }) => {
  await app.open();
  await app.selectSidebar(/^Solo Blog\s*\d+$/);
  await app.activate(app.row(8));
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Solo Blog" })).toBeVisible();
  await expect(page.locator("article").filter({ hasText: "(#008)" })).toBeVisible();
});

// Guard for P1-03: when URL-based navigation lands, j/k must keep REPLACING
// the entry (not pushing), so history length must stay constant while moving.
test("j/k moves between articles without growing history", async ({ app, page, isMobile }) => {
  test.skip(isMobile, "keyboard shortcut; desktop only");
  await app.open();
  await app.activate(app.row(1));
  await expect(page.locator("article").filter({ hasText: "(#001)" })).toBeVisible();
  const before = await page.evaluate(() => history.length);
  await page.keyboard.press("j");
  await expect(page.locator("article").filter({ hasText: "(#002)" })).toBeVisible();
  await page.keyboard.press("k");
  await expect(page.locator("article").filter({ hasText: "(#001)" })).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(before);
});
