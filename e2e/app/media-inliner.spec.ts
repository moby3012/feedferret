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
