import type { ConsoleMessage, Page } from "@playwright/test";
import { ACTIVE_LIST, test, expect } from "../helpers/test";
import { articleFlags } from "../helpers/db";

/**
 * Shell spec PR 5 ("cold start", §2.5): the server prefetches the shell's data
 * and dehydrates it into the HTML, the session seeds SessionProvider, a
 * skeleton (never a spinner) streams first and the heavy UI is lazy.
 */

// Production React reports hydration mismatches as minified errors (#418 text,
// #419/#421/#422 suspense, #423 recoverable, #425 text content).
const HYDRATION = /hydrat|did not match|server rendered HTML|Minified React error #(418|419|421|422|423|425)/i;

function watchHydration(page: Page) {
  const problems: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if ((m.type() === "error" || m.type() === "warning") && HYDRATION.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

/** Data requests (server actions + /api/*) in order. */
function watchData(page: Page) {
  const log: { path: string; action: boolean }[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    const action = !!r.headers()["next-action"];
    if (action || url.pathname.startsWith("/api/")) log.push({ path: url.pathname + url.search, action });
  });
  return log;
}

test("the HTML of / already contains the first rows (server bootstrap)", async ({ app, page }) => {
  const res = await page.request.get("/");
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain(app.user.firstArticleTitle);
  expect(html).toMatch(/role="button"[^>]*aria-label="Unread: /);
  // Only the Latin subset of the UI font is preloaded (no Geist Mono / full
  // Geist): Next sends the preloads as a Link header.
  const fontPreloads = (res.headers()["link"] ?? "").split(/,\s*(?=<)/).filter((l) => /as="?font/.test(l));
  expect(fontPreloads).toHaveLength(1);
  expect(fontPreloads[0]).toContain("geist_latin");
  // KaTeX / highlight.js CSS ship with the reader chunk, not with every page.
  const sheets = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/g)].map((m) => m[1]);
  expect(sheets.length).toBeGreaterThan(0);
  for (const href of sheets) expect(await (await page.request.get(href)).text()).not.toMatch(/KaTeX_|\.hljs/);
});

test("cold start: rows painted from the HTML, no data request but the lazy sync, no hydration error", async ({ app, page }) => {
  const problems = watchHydration(page);
  const data = watchData(page);
  await page.goto("/");
  await expect(app.row(1)).toBeVisible();
  await page.waitForLoadState("networkidle");
  await app.navReady();

  // The rows need no request at all. The boot sends no server action and none
  // of the shell's reads (session / list / counts / entities come with the
  // HTML): only the lazy sync, plus on wide the post-mount sidebar's instance
  // info.
  expect(data.filter((d) => d.action)).toEqual([]);
  expect(data.map((d) => d.path).filter((p) => !/^\/api\/(sync|instance)(\?|$)/.test(p))).toEqual([]);
  expect(data.length).toBeLessThanOrEqual(app.isMobile ? 1 : 4);
  // The skeleton is gone and the real shell is interactive.
  await expect(page.locator("[data-shell-skeleton]")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "All articles" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("deep link to an article: reader and body come with the HTML, no detail request", async ({ app, page }) => {
  const problems = watchHydration(page);
  const id = app.articleId(1);
  // (The reader prefetches the next two bodies when idle — only the open one counts.)
  const detailRequests: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === `/api/app/articles/${id}`) detailRequests.push(r.url());
  });
  const html = await (await page.request.get(`/?a=${id}`)).text();
  // Rendered reader markup, not just the dehydrated detail in the RSC payload:
  // the body text sits inside the server-rendered `.article-content` element.
  const bodyText = app.user.firstArticleBodyStart.slice(0, 25).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  expect(html).toMatch(new RegExp(`class="[^"]*\\barticle-content\\b[^"]*"[^>]*>(?:\\s*<[^>]+>)*\\s*${bodyText}`));
  expect(html).not.toContain('data-testid="reader-body-loading"');

  await page.goto(`/?a=${id}`);
  const reader = page.locator("article").filter({ hasText: app.user.firstArticleTitle });
  await expect(reader.locator(".article-content")).toContainText(app.user.firstArticleBodyStart.slice(0, 25));
  await app.navReady();
  expect(detailRequests).toEqual([]);
  expect(problems).toEqual([]);
});

test("RSC requests of / (router.refresh, soft navigation back from /settings) carry no bootstrap", async ({ app, page }) => {
  await app.open();
  const rscBodies: Promise<string>[] = [];
  page.on("response", (r) => {
    const url = new URL(r.url());
    if (url.pathname === "/" && r.request().headers()["rsc"] === "1" && !r.request().headers()["next-router-prefetch"]) {
      rscBodies.push(r.text().catch(() => ""));
    }
  });

  const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === "/" && r.request().headers()["rsc"] === "1");
  await page.evaluate(() => (window as unknown as { next: { router: { refresh(): void } } }).next.router.refresh());
  await refreshed;
  await expect(app.row(1)).toBeVisible();

  await page.evaluate(() => (window as unknown as { next: { router: { push(href: string): void } } }).next.router.push("/settings"));
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible({ timeout: 20_000 });
  await app.activate(page.getByRole("button", { name: "Back" }).first());
  await expect(page).toHaveURL(/\/$/);
  await expect(app.row(1)).toBeVisible({ timeout: 30_000 });

  const bodies = await Promise.all(rscBodies);
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) expect(body).not.toContain(app.user.firstArticleTitle);
});

test("refresh without Fetch Metadata during an unconfirmed write: the server snapshot never overwrites it", async ({ app, page }) => {
  await app.open();
  const unreadBefore = await app.sidebarCount("All articles");
  const id = app.articleId(2);

  // Router refreshes of `/` go out from the test runner instead of the browser:
  // no Fetch Metadata (old browser / stripping proxy), so the server builds
  // and sends its bootstrap snapshot. Its delivery is held for a moment.
  const snapshots: { isReadInDb: boolean; body: string }[] = [];
  await page.route("**/*", async (route) => {
    const r = route.request();
    const headers = await r.allHeaders();
    if (new URL(r.url()).pathname !== "/" || headers["rsc"] !== "1") return route.fallback();
    delete headers["sec-fetch-dest"];
    const response = await route.fetch({ headers });
    const body = await response.text();
    snapshots.push({ isReadInDb: articleFlags(id).isRead, body });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ response, body });
  });

  // Mark #002 read and refresh in the same task: the write is still queued in
  // the batcher (400 ms window) and Next runs the server action only after
  // the refresh — the snapshot is built while the server has not seen it.
  const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === "/" && r.request().headers()["rsc"] === "1");
  await page.evaluate(() => {
    const row = document.querySelector('[data-pane^="list-"][data-active="true"] [role="button"][aria-label*="(#002)"]');
    const read = [...(row?.querySelectorAll("button") ?? [])].find((b) => b.getAttribute("aria-label") === "Mark as read");
    read!.click();
    (window as unknown as { next: { router: { refresh(): void } } }).next.router.refresh();
  });
  await app.expectRow(2, { read: true });
  await refreshed;
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0].isReadInDb).toBe(false);
  expect(snapshots[0].body).toContain(app.user.firstArticleTitle); // the snapshot was sent

  // The write goes out after the refresh was applied and is committed.
  await expect.poll(() => articleFlags(id).isRead, { timeout: 15_000 }).toBe(true);
  await page.waitForLoadState("networkidle").catch(() => {});
  // The optimistic state was never replaced by the snapshot's "unread".
  await app.expectRow(2, { read: true });
  expect(await app.sidebarCount("All articles")).toBe(unreadBefore - 1);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

/** y of the active list's first row in every frame from the first paint of the HTML on (before hydration). */
async function sampleFirstRowY(page: Page) {
  await page.addInitScript(() => {
    const ys: number[] = [];
    (window as unknown as { __firstRowY: number[] }).__firstRowY = ys;
    const tick = () => {
      const row = document.querySelector('[data-pane^="list-"][data-active="true"] [data-article-id]');
      // (Streamed-in HTML waits in a hidden container until React swaps it in.)
      if (row && row.getClientRects().length > 0) ys.push(Math.round(row.getBoundingClientRect().top * 10) / 10);
      if (ys.length < 5_000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return () => page.evaluate(() => [...new Set((window as unknown as { __firstRowY: number[] }).__firstRowY)]);
}

for (const collapsed of [false, true]) {
  test(`briefing card (${collapsed ? "collapsed" : "expanded"} in ff_ui) is in the HTML; rows do not move across hydration`, async ({ app, page, baseURL }) => {
    if (collapsed) await page.context().addCookies([{ name: "ff_ui", value: encodeURIComponent(JSON.stringify({ bc: 1 })), url: baseURL! }]);
    const problems = watchHydration(page);
    const data = watchData(page);

    const html = await (await page.request.get("/")).text();
    const card = /<section[^>]*data-testid="briefing-card"[^>]*data-state="(\w+)"/.exec(html);
    expect(card, "briefing card in the server HTML").not.toBeNull();
    expect(card![1]).toBe(collapsed ? "collapsed" : "expanded");
    expect(html).toContain('data-testid="briefing-header"');

    const ys = await sampleFirstRowY(page);
    await page.goto("/");
    await expect(app.row(1)).toBeVisible();
    await page.waitForLoadState("networkidle");
    await app.navReady();
    const cardEl = page.locator(`${ACTIVE_LIST} [data-testid="briefing-card"]`);
    await expect(cardEl).toHaveAttribute("data-state", collapsed ? "collapsed" : "expanded");
    expect(await ys()).toHaveLength(1);
    // The card's state came with the HTML: no briefing GET on boot.
    expect(data.map((d) => d.path).filter((p) => p.startsWith("/api/app/briefing"))).toEqual([]);
    expect(problems).toEqual([]);
  });
}
