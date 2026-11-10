import { test, expect } from "@playwright/test";

test("sets, uses and revokes an API password from account settings", async ({ page, isMobile }) => {
  await page.addInitScript(() => localStorage.setItem("feedferret:pwa-install-prompt-dismissed", "1"));
  await page.goto("/settings");
  if (isMobile) {
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Account", exact: true }).click();
  } else {
    await page.getByRole("tab", { name: /account/i }).click();
  }
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "API password", exact: true }) });
  await section.getByLabel("New API password (24–72 bytes; leave blank to generate)").fill("playwright-api-password-long-secret");
  await section.getByLabel("Current login password or TOTP code").fill("e2e-password-123");
  await section.getByRole("button", { name: "Set / rotate password" }).click();
  await expect(section.getByText("API password configured", { exact: true })).toBeVisible();
  await expect(section.getByLabel("New API password (24–72 bytes; leave blank to generate)")).toHaveValue("");
  const email = test.info().project.name === "mobile" ? "e2e-mobile@feedferret.test" : "e2e-desktop@feedferret.test";
  const login = await page.request.post("/api/greader.php/accounts/ClientLogin", { form: { Email: email, Passwd: "playwright-api-password-long-secret" } });
  expect(login.status()).toBe(200);
  const token = (await login.text()).match(/Auth=(.+)/)![1];
  await section.getByLabel("Current login password or TOTP code").fill("e2e-password-123");
  await section.getByRole("button", { name: "Revoke password" }).click();
  await expect(section.getByText("No API password configured", { exact: true })).toBeVisible();
  expect((await page.request.get("/api/greader.php/reader/api/0/tag/list", { headers: { Authorization: `GoogleLogin auth=${token}` } })).status()).toBe(401);
});

test.afterEach(async ({ page }) => {
  await page.request.post("/api/user/api-password", { data: { currentPassword: "e2e-password-123", required: true, revoke: true } });
  await page.request.post("/api/user/api-password", { data: { currentPassword: "e2e-password-123", required: false, policyOnly: true } });
});
