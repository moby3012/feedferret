import type { Page } from "@playwright/test";
import { test, expect } from "../helpers/test";

// Capability hints in the Add Feed dialog. Discovery is mocked at the
// /api/discover boundary: e2e/CI must never reach the internet (x.com, …), and
// the server-side hint derivation (RSSHub radar match, 429 → rate-limited,
// 401/403 → blocked) is covered by tests/lib/capability-hints.test.ts.

const INPUT = "Feed or site URL, @handle, or topic";

async function openAddFeed(app: { page: Page }) {
  await app.page.goto("/?addFeed=1");
  const dialog = app.page.getByRole("dialog", { name: "Add Feed" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  return dialog;
}

async function mockDiscovery(page: Page, hint: string) {
  const requested: string[] = [];
  await page.route("**/api/discover?**", async (route) => {
    requested.push(new URL(route.request().url()).searchParams.get("url") ?? "");
    await route.fulfill({ json: { feeds: [], mode: "url", hint } });
  });
  return requested;
}

for (const { hint, url, message } of [
  { hint: "needs-rsshub", url: "https://social.invalid/NASA", message: "Requires RSSHub – configure under Settings › Server" },
  { hint: "rate-limited", url: "https://busy.invalid/", message: "Try again later" },
  { hint: "blocked", url: "https://walled.invalid/", message: "This site blocked automated access – try a native feed from the publisher" },
]) {
  test(`shows the "${hint}" capability hint`, async ({ app }) => {
    const requested = await mockDiscovery(app.page, hint);
    const dialog = await openAddFeed(app);
    const input = dialog.getByPlaceholder(INPUT);
    await input.fill(url);
    await input.press("Enter");
    await expect(dialog.getByText(message)).toBeVisible({ timeout: 10_000 });
    expect(requested).toEqual([url]);
  });
}

test("the needs-rsshub hint names the platform that has no native feed", async ({ app }) => {
  await app.page.route("**/api/discover?**", async (route) => {
    await route.fulfill({ json: { feeds: [], mode: "url", hint: "needs-rsshub", hintPlatform: "X/Twitter" } });
  });
  const dialog = await openAddFeed(app);
  const input = dialog.getByPlaceholder(INPUT);
  await input.fill("https://social.invalid/EA");
  await input.press("Enter");
  await expect(dialog.getByText("X/Twitter has no feed of its own – requires RSSHub (configure under Settings › Server)")).toBeVisible({
    timeout: 10_000,
  });
});
