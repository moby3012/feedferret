import { test, expect } from "../helpers/test";
import type { App } from "../helpers/test";
import { categoryExists, insertEmptyCategory } from "../helpers/db";

/**
 * Empty category → "No feeds · Delete category" inline in the expanded folder (desktop sidebar and
 * the compact Feeds tab). Confirm dialog, then the folder is gone. Never shown for a category with
 * feeds or subcategories. Seed: Tech / News / Culture all have feeds. Test categories are removed again.
 */

const cleanups: Array<() => void> = [];
test.afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function reopen(app: App) {
  await app.open();
  await app.openSidebar();
}

async function expandFolder(app: App, name: string) {
  const toggle = app.sidebar().getByRole("button", { name: `Expand ${name}` });
  await expect(toggle).toBeVisible();
  await app.activate(toggle);
  await expect(app.sidebar().getByRole("button", { name: `Collapse ${name}` })).toBeVisible();
}

test.describe("inline delete of an empty category", () => {
  test("empty category: expand → Delete category → confirm → gone", async ({ app, page }) => {
    const cat = insertEmptyCategory(app.userKey, "Zebra Empty");
    cleanups.push(cat.cleanup);
    await reopen(app);
    await expandFolder(app, "Zebra Empty");
    await expect(app.sidebar().getByText("No feeds")).toBeVisible();

    const del = app.sidebar().getByRole("button", { name: "Delete empty category Zebra Empty" });
    await expect(del).toBeVisible();
    await expect(del).toHaveText("Delete category");

    // Cancel keeps it.
    await app.activate(del);
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Delete category “Zebra Empty”?");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(categoryExists(cat.id)).toBe(true);

    // Keyboard: focus + Enter opens the confirm; confirm deletes.
    await del.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Delete category" }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Category deleted" })).toBeVisible();
    await expect(app.sidebar().getByRole("button", { name: "Collapse Zebra Empty" })).toHaveCount(0);
    await expect(app.sidebar().getByText("Zebra Empty")).toHaveCount(0);
    await expect.poll(() => categoryExists(cat.id)).toBe(false);
  });

  test("category with feeds shows no delete action", async ({ app, page }) => {
    const cat = insertEmptyCategory(app.userKey, "Zebra Empty");
    cleanups.push(cat.cleanup);
    await reopen(app);
    await expandFolder(app, "Tech");
    await expect(app.sidebar().getByText("Hacker Dispatch").first()).toBeVisible();
    await expect(app.sidebar().getByTestId("delete-empty-category")).toHaveCount(0);
    await expect(app.sidebar().getByText("No feeds")).toHaveCount(0);
  });

  test("category with a subcategory shows no delete action", async ({ app, page }) => {
    const parent = insertEmptyCategory(app.userKey, "Zebra Parent");
    cleanups.push(parent.cleanup);
    const kid = insertEmptyCategory(app.userKey, "Zebra Kid", parent.id);
    cleanups.push(kid.cleanup);
    await reopen(app);
    await expandFolder(app, "Zebra Parent");
    await expect(app.sidebar().getByText("No feeds")).toBeVisible();
    await expect(app.sidebar().getByRole("button", { name: "Delete empty category Zebra Parent" })).toHaveCount(0);
    // The leaf below it is a plain empty category.
    await expandFolder(app, "Zebra Kid");
    await expect(app.sidebar().getByRole("button", { name: "Delete empty category Zebra Kid" })).toBeVisible();
  });
});
