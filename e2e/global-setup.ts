import fs from "node:fs";
import path from "node:path";
import { chromium, type FullConfig } from "@playwright/test";

/**
 * Logs in once per seeded user through the REAL login form and stores the
 * session cookie as storageState (e2e/.auth/<user>.json). Authenticated
 * projects load it via `use.storageState`.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL!;
  const manifest = JSON.parse(fs.readFileSync(path.resolve(".e2e", "manifest.json"), "utf8"));
  fs.mkdirSync(path.resolve("e2e", ".auth"), { recursive: true });

  const browser = await chromium.launch();
  try {
    for (const [key, user] of Object.entries<{ email: string }>(manifest.users)) {
      if (key === "perf") continue; // the perf script logs in on its own
      const context = await browser.newContext({ baseURL, locale: "en-US" });
      const page = await context.newPage();
      await page.goto("/login");
      await page.getByPlaceholder("Email").fill(user.email);
      await page.getByPlaceholder("Password").fill(manifest.password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
      await context.storageState({ path: path.resolve("e2e", ".auth", `${key}.json`) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
