import { test, expect, openSettingsSection } from "../helpers/test";
import { plantFeedSecrets } from "../helpers/db";

// Security wave 3 (audit #2, N4): the reader shell's SSR bootstrap used to
// embed whole Feed rows — plaintext Basic-Auth password, username, cookies /
// headers (httpOptions) and scraper config — into every page's HTML.
test("the SSR HTML and the hydrated shell of / carry none of the feed secrets", async ({ app, page }) => {
  const { secrets, restore } = plantFeedSecrets(app.userKey);
  try {
    const response = await page.request.get("/");
    expect(response.status()).toBe(200);
    const html = await response.text();
    // Sanity: this really is the bootstrapped shell with the user's feeds.
    expect(html).toContain(app.user.firstArticleFeed);
    for (const secret of secrets) expect(html).not.toContain(secret);

    await page.goto("/");
    await expect(app.rows().first()).toBeVisible();
    const dom = await page.content();
    for (const secret of secrets) expect(dom).not.toContain(secret);
  } finally {
    restore();
  }
});

// N17: changing the sign-in email needs the current password (or a TOTP code).
test("changing the email asks for step-up and refuses without it", async ({ page, isMobile }) => {
  await openSettingsSection(page, isMobile, "Account");
  const section = page.getByTestId("email-change-section");
  // The e2e instance has no mail delivery: the dialog says no confirmation goes out.
  await expect(section.getByTestId("email-change-no-mail")).toContainText("no confirmation will be sent");
  await section.getByLabel("New email address").fill("attacker@evil.test");
  await expect(section.getByLabel("Current password or 2FA code")).toBeVisible();
  await section.getByRole("button", { name: "Update email" }).click();
  await expect(page.getByText("Enter your current login password or a new, unused TOTP code.")).toBeVisible();
  await section.getByLabel("Current password or 2FA code").fill("definitely-wrong");
  await section.getByRole("button", { name: "Update email" }).click();
  await expect(page.getByText("Enter your current login password or a new, unused TOTP code.").first()).toBeVisible();
  // Still signed in with the seeded address.
  const session = await (await page.request.get("/api/auth/session")).json();
  expect(session.user.email).toMatch(/^e2e-(desktop|mobile)@feedferret\.test$/);
});
