import { test, expect } from "./helpers/csp-test";
import { manifest } from "./helpers/db";

// Sign-in is rate limited (10 POSTs / 15 min / IP), so keep this spec to two logins.

test("credentials login lands on the seeded, authenticated app", async ({ page }) => {
  const { users, password } = manifest();
  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(users.desktop.email);
  await page.getByPlaceholder("Password").fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  await expect(page.locator('[role="button"][aria-label*="(#001)"]')).toBeVisible({ timeout: 30_000 });
});

test("unauthenticated visitor on a seeded instance gets the login page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
  await expect(page.getByPlaceholder("Email")).toBeVisible();
});
