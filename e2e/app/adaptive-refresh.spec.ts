import { test, expect } from "../helpers/test";

test("feed fetch options expose automatic cadence and an explicit interval", async ({ app, page }) => {
  await app.open();
  await page.goto("/manage-feeds");
  await page.getByRole("button", { name: "Settings" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Fetch Options" }).click();
  const interval = dialog.getByPlaceholder("Automatic", { exact: true });
  await interval.fill("");
  await expect(dialog.getByText(/Automatic \((learning|avg\.)/)).toBeVisible();
  await interval.fill("30");
  await expect(interval).toHaveValue("30");
  await expect(dialog.getByText(/Automatic \((learning|avg\.)/)).toHaveCount(0);
  await interval.fill("");
  await expect(dialog.getByText(/Automatic \((learning|avg\.)/)).toBeVisible();
});
