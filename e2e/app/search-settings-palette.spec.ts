import { test, expect } from "../helpers/test";

test("search finds the seeded needle articles", async ({ app, page }) => {
  await app.open();
  await app.openSearch();
  await page.keyboard.type(app.user.sample.needle);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: new RegExp(app.user.sample.needle) })).toBeVisible();
  const hits = app.rowsMatching(app.user.sample.needle);
  await expect(hits).toHaveCount(app.user.sample.needleHits);
  await expect(app.row(18)).toBeVisible(); // needle articles are #018, #118, #218
});

test("settings page opens and a tab switch works", async ({ app, page }) => {
  await app.open();
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("tabpanel", { name: "Appearance" })).toBeVisible();

  if (app.isMobile) {
    // Phone: tabs collapse into a <Select> (audit P1-14 replaces it with a segmented control).
    await page.getByRole("combobox").first().tap();
    await page.getByRole("option", { name: "Reading" }).tap();
  } else {
    await page.getByRole("tab", { name: "Reading" }).click();
  }
  await expect(page.getByRole("tabpanel", { name: "Reading" })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Appearance" })).toBeHidden();
});

test("settings back button returns to the app", async ({ app, page }) => {
  await app.open();
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Back" }).first()).toBeVisible({ timeout: 20_000 });
  await app.activate(page.getByRole("button", { name: "Back" }).first());
  await expect(page).toHaveURL(/\/$/);
  await expect(app.row(1)).toBeVisible({ timeout: 30_000 });
});

test("command palette opens with Ctrl/Cmd+K and closes with Escape", async ({ app, page }) => {
  await app.open();
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByPlaceholder("Type a command or search…");
  await expect(input).toBeVisible();
  await expect(page.getByText("Refresh all feeds")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();
});

test("mobile: PWA install hint currently shows as a blocking modal on first load", async ({ app, page, isMobile }) => {
  test.skip(!isMobile, "mobile only");
  // Undo the fixture's suppression so the first-run behaviour is observed.
  await page.context().addInitScript(() => localStorage.removeItem("feedferret:pwa-install-prompt-dismissed"));
  await page.goto("/");
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Add to Home Screen" })).toBeVisible({ timeout: 20_000 });
  void app;
});

test.fixme("mobile: PWA install hint must not block first use (P1-11 non-blocking, after 2nd session)", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile only");
  await page.goto("/");
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Add to Home Screen" })).toBeHidden({ timeout: 10_000 });
});
