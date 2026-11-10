import type { Page, Request } from "@playwright/test";
import { test, expect, type App } from "../helpers/test";

/**
 * The shell owns in-app history, but Next's app router must keep seeing every
 * traversal: its popstate handler is what cancels a router navigation that is
 * still pending (a Link / router.push to another route), and its router state
 * backs refresh() / server actions once the user comes back from another route.
 */

const reader = (page: Page, num: number) => page.locator("article").filter({ hasText: `(#${String(num).padStart(3, "0")})` });
const settingsHeading = (page: Page) => page.getByRole("heading", { level: 1, name: "Settings" });

/** A router navigation to /settings, as users start it: the sidebar <Link> (wide) / router.push (compact, palette & menu). */
async function goToSettings(app: App, page: Page) {
  if (app.isMobile) await page.evaluate(() => (window as unknown as { next: { router: { push(href: string): void } } }).next.router.push("/settings"));
  else await app.activate(page.locator('a[href="/settings"]').first());
}

const isSettingsNavRequest = (r: Request) => new URL(r.url()).pathname === "/settings" && !r.headers()["next-router-prefetch"];

test("Back while a router navigation to /settings is still pending cancels it: the user ends on the list", async ({ app, page }) => {
  await app.open();
  await app.activate(app.row(2));
  await expect(reader(page, 2)).toBeVisible();
  await expect.poll(() => app.where()).toBe(`/?a=${app.articleId(2)}`);

  // Hold the navigation's server request until after Back.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held: Request[] = [];
  await page.route(
    (url) => url.pathname === "/settings",
    async (route) => {
      if (!isSettingsNavRequest(route.request())) return route.continue();
      held.push(route.request());
      await gate;
      await route.continue().catch(() => {}); // the router may have aborted it
    },
  );

  await goToSettings(app, page);
  await expect.poll(() => held.length, { message: "the /settings navigation is in flight" }).toBeGreaterThan(0);
  expect(app.where()).toBe(`/?a=${app.articleId(2)}`); // not committed yet

  await page.goBack();
  await expect.poll(() => app.where()).toBe("/");
  await app.navReady();

  const settled = Promise.all(held.map((r) => r.response().catch(() => null)));
  release();
  await settled;
  // A stale commit would land within a few frames of the response; give it ample time.
  await page.waitForTimeout(1000);

  expect(app.where()).toBe("/");
  await expect(settingsHeading(page)).toHaveCount(0);
  await expect(reader(page, 2)).toBeHidden();
  await expect(app.row(2)).toBeVisible();
  await page.unroute((url) => url.pathname === "/settings");
});

test("shell Back → router navigation to /settings → Back/Forward → router.refresh(): stack and router stay in sync", async ({ app, page }) => {
  await app.open();
  await app.activate(app.row(1));
  await expect(reader(page, 1)).toBeVisible();
  await page.goBack(); // shell traversal
  await expect.poll(() => app.where()).toBe("/");
  await expect(reader(page, 1)).toBeHidden();

  await goToSettings(app, page);
  await expect(settingsHeading(page)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => app.where()).toBe("/settings");

  await page.goBack(); // Next traversal back into the shell
  await expect.poll(() => app.where()).toBe("/");
  await expect(app.row(1)).toBeVisible();
  await app.navReady();

  await page.goForward();
  await expect(settingsHeading(page)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => app.where()).toBe("/settings");

  await page.goBack();
  await expect.poll(() => app.where()).toBe("/");
  await expect(app.row(1)).toBeVisible();
  await app.navReady();

  // router.refresh() on the shell: re-renders server components, keeps URL + our `ff`.
  const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === "/" && r.request().headers()["rsc"] === "1");
  await page.evaluate(() => (window as unknown as { next: { router: { refresh(): void } } }).next.router.refresh());
  await refreshed;
  await expect.poll(() => app.where()).toBe("/");
  await app.navReady();
  await expect(app.row(1)).toBeVisible();

  // The shell stack still works after the refresh.
  await app.activate(app.row(3));
  await expect(reader(page, 3)).toBeVisible();
  await expect.poll(() => app.where()).toBe(`/?a=${app.articleId(3)}`);
  await page.goBack();
  await expect.poll(() => app.where()).toBe("/");
  await expect(reader(page, 3)).toBeHidden();
  await expect(app.row(3)).toBeVisible();
  await expect(settingsHeading(page)).toHaveCount(0);
});
