import { test, expect, type Page } from "./helpers/csp-test";

// Public pages (no session) follow the persisted theme for the OS chrome too:
// `<meta name="theme-color">` is the bar surface of the resolved theme
// (lib/theme-color.ts), even when the OS colour scheme disagrees.
const DARK = "#080b10";
const LIGHT = "#f9fafc";

const themeColors = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content")));

test("login page: persisted dark theme under a light OS scheme → dark theme-color", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  await page.goto("/login");
  await expect(page.getByPlaceholder("Email")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => themeColors(page)).toEqual([DARK, DARK]);
});

test("login page: persisted light theme under a dark OS scheme → light theme-color", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.goto("/login");
  await expect(page.getByPlaceholder("Email")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => themeColors(page)).toEqual([LIGHT, LIGHT]);
});
