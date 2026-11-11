import { test, expect } from "./helpers/csp-test";

// The service worker installs on the login page, before any session exists. The
// auth proxy must not redirect its precache files to /login (that HTML would
// otherwise be cached as the "offline page").
test.use({ serviceWorkers: "allow" });

test("anonymous install precaches the real offline page, not the login page", async ({ page }) => {
  await page.goto("/offline.html");
  await page.evaluate(async () => {
    const old = await caches.open("feedferret-pwa-v4");
    await old.put("/offline.html", new Response("old inline-handler shell"));
  });
  await page.goto("/login");
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cached = await page.evaluate(async () => {
    const cache = await caches.open("feedferret-pwa-v5");
    const read = async (path: string) => {
      const res = await cache.match(path);
      return res ? { type: res.headers.get("content-type"), text: await res.text() } : null;
    };
    return { offline: await read("/offline.html"), reader: await read("/offline-reader.js"), manifest: await read("/manifest.json") };
  });
  expect(await page.evaluate(() => caches.keys())).not.toContain("feedferret-pwa-v4");
  expect(cached.offline?.text).toContain("FeedFerret Offline");
  expect(cached.offline?.text).not.toContain("onclick=");
  expect(cached.reader?.text).toContain('getElementById("retry").addEventListener');
  expect(cached.offline?.text).not.toMatch(/Sign in|type="password"/i);
  expect(cached.reader?.text).toContain("feedferret-offline");
  expect(JSON.parse(cached.manifest!.text).name).toBeTruthy();
});

test("navigation without a connection falls back to the offline page", async ({ page, context }) => {
  await page.goto("/login");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled
  await context.setOffline(true);
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1, name: "You are offline" })).toBeVisible();
  await context.setOffline(false);
});
