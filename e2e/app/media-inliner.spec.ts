import Database from "better-sqlite3";
import { manifest } from "../helpers/db";
import { test, expect } from "../helpers/test";

test("video remains inert until the reader clicks load", async ({ app, page }) => {
  const db = new Database(manifest().dbPath);
  const id = manifest().users[app.userKey].firstArticleId;
  const original = db.prepare('SELECT content, updatedAt FROM "Article" WHERE id = ?').get(id) as { content: string; updatedAt: number };
  const content = '<p>Video fixture</p><a href="https://www.youtube.com/shorts/fixture1234">Watch video</a>';
  db.prepare('UPDATE "Article" SET content = ? WHERE id = ?').run(content, id);
  const requests: string[] = [];
  await page.route("https://www.youtube-nocookie.com/**", route => { requests.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<p>Local player fixture</p>" }); });
  page.on("request", req => {
    const host = new URL(req.url()).hostname;
    if (["www.youtube.com", "i.ytimg.com"].includes(host)) requests.push(req.url());
  });
  try {
    await app.open();
    await app.activate(app.row(1));
    const button = page.locator('.article-content button[data-ff-video]');
    await expect(button).toBeVisible();
    await expect(page.locator(".article-content iframe")).toHaveCount(0);
    expect(requests).toEqual([]);
    await button.click();
    const frame = page.locator(".article-content iframe");
    await expect(frame).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/fixture1234");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
    await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect.poll(() => requests.length).toBe(1);
    const stored = db.prepare('SELECT content, updatedAt FROM "Article" WHERE id = ?').get(id);
    expect(stored).toEqual({ content, updatedAt: original.updatedAt });
  } finally {
    db.prepare('UPDATE "Article" SET content = ? WHERE id = ?').run(original.content, id);
    db.close();
  }
});

test("Reddit click-to-load media is allowed by enforced and report-only CSP", async ({ app, page }) => {
  const db = new Database(manifest().dbPath);
  const id = manifest().users[app.userKey].firstArticleId;
  const original = db.prepare('SELECT content FROM "Article" WHERE id = ?').get(id) as { content: string };
  db.prepare('UPDATE "Article" SET content = ? WHERE id = ?').run('<p>Reddit video fixture</p><a href="https://v.redd.it/fixture">video</a>', id);
  const mediaRequests: string[] = [];
  await page.route("https://v.redd.it/**", route => {
    mediaRequests.push(route.request().url());
    // Only request admission is under test; no external media is downloaded.
    return route.fulfill({ contentType: "video/mp4", body: Buffer.alloc(0) });
  });
  try {
    const response = await page.request.get("/");
    expect(response.headers()["content-security-policy"]).toContain("media-src 'self' https://v.redd.it");
    expect(response.headers()["content-security-policy-report-only"]).toContain("media-src 'self' https://v.redd.it");
    await app.open();
    await app.activate(app.row(1));
    await page.evaluate(() => {
      const violations: string[] = [];
      Object.assign(window, { mediaCspViolations: violations });
      document.addEventListener("securitypolicyviolation", event => { if (event.effectiveDirective === "media-src") violations.push(event.blockedURI); });
    });
    const button = page.locator('.article-content button[data-ff-video]');
    await expect(button).toBeVisible();
    expect(mediaRequests).toEqual([]);
    await button.click();
    const video = page.locator(".article-content video");
    await expect(video).toHaveAttribute("src", "https://v.redd.it/fixture/DASH_720.mp4");
    await video.evaluate(el => { void (el as HTMLVideoElement).play().catch(() => {}); });
    await expect.poll(() => mediaRequests.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { mediaCspViolations: string[] }).mediaCspViolations)).toEqual([]);
  } finally {
    db.prepare('UPDATE "Article" SET content = ? WHERE id = ?').run(original.content, id);
    db.close();
  }
});
