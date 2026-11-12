import { test, expect } from "../helpers/test";

test("Twitch settings seal credentials and explain setup", async ({ page }) => {
  await page.goto("/server-settings?tab=sync");
  const panel = page.getByTestId("twitch-settings");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("link", { name: "dev.twitch.tv/console" })).toHaveAttribute("href", "https://dev.twitch.tv/console");
  await expect(panel).toContainText("http://localhost");
  await expect(panel).toContainText("Website Integration");
  await panel.getByLabel("Twitch Client ID", { exact: true }).fill("synthetic-e2e-id");
  await panel.getByLabel("Twitch Client Secret", { exact: true }).fill("synthetic-e2e-secret");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByLabel("Twitch Client Secret", { exact: true })).toHaveValue("");
  await page.reload();
  await expect(panel.getByLabel("Twitch Client ID", { exact: true })).toHaveValue("synthetic-e2e-id");
  await expect(panel.getByLabel("Twitch Client Secret", { exact: true })).toHaveValue("");
  await expect(panel).toContainText("Value stored securely");
  // Disable the synthetic configuration without making an external request.
  await panel.getByLabel("Twitch Client ID", { exact: true }).fill("");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByLabel("Twitch Client ID", { exact: true })).toHaveValue("");
});
