import type { Page } from "@playwright/test";
import { test, expect } from "./helpers/csp-test";
import { createTotpUser, manifest, userColumns } from "./helpers/db";
import { sealForE2e } from "./helpers/secrets";
import { generateTotpToken } from "../lib/totp";

// M8 (security audit #2): TOTP login works with a plaintext secret and with a
// v2-sealed one (this release reads v2, still writes plaintext), and a used
// code cannot be replayed. Sign-in is rate limited (10 POSTs / 15 min / IP):
// this spec makes three sign-in attempts.

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

async function signIn(page: Page, email: string, code: string) {
  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(manifest().password);
  await page.locator('button[type="submit"]').click();
  const otp = page.getByPlaceholder("Authenticator code");
  await expect(otp).toBeVisible({ timeout: 30_000 });
  await otp.fill(code);
  await page.locator('button[type="submit"]').click();
}

test("TOTP login with a plaintext secret", async ({ page }) => {
  const user = createTotpUser("desktop", "totp-plain", SECRET);
  try {
    await signIn(page, user.email, generateTotpToken(SECRET));
    await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  } finally {
    user.cleanup();
  }
});

test("TOTP login with a v2-sealed secret; the same code is refused on replay", async ({ page, browser }) => {
  const sealed = sealForE2e("user.twoFactorSecret", SECRET);
  const user = createTotpUser("desktop", "totp-sealed", sealed);
  try {
    const code = generateTotpToken(SECRET);
    await signIn(page, user.email, code);
    await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });

    const replay = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: "en-US", serviceWorkers: "block" });
    try {
      const replayPage = await replay.newPage();
      await signIn(replayPage, user.email, code);
      await expect(replayPage.getByText(/Password or authenticator code incorrect, or too many attempts/)).toBeVisible({ timeout: 30_000 });
      expect(new URL(replayPage.url()).pathname).toBe("/login");
    } finally {
      await replay.close();
    }
    // Read-only release: the stored value is untouched (no re-seal, no plaintext write-back).
    expect(userColumns({ email: user.email }, ["twoFactorSecret"]).twoFactorSecret).toBe(sealed);
  } finally {
    user.cleanup();
  }
});
