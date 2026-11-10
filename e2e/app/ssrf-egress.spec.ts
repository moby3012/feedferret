import Database from "better-sqlite3";
import { test, expect } from "../helpers/test";
import { manifest } from "../helpers/db";

test("offline feed add, private proxy refusal, opted-in sync and full-text extraction", async ({ app, page }) => {
  await page.goto("/");
  expect(app.user.userId).toBeTruthy();
  const origin = new URL(page.url()).origin;
  const fixture = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT || 4010}`;
  const headers = { Origin: origin };
  const db = new Database(manifest().dbPath);
  db.pragma("busy_timeout = 5000");
  const old = db.prepare('SELECT allowInternalFeedUrls FROM "GlobalSettings" WHERE id = ?').get("global") as { allowInternalFeedUrls: number };
  let feedId: string | undefined;
  try {
    const created = await page.request.post("/api/v1/feeds", { headers, data: { url: `${fixture}/h4/feed`, name: "H4 offline", sync: false } });
    expect(created.status()).toBe(201);
    feedId = (await created.json()).id;
    const proxy = await page.request.patch(`/api/v1/feeds/${feedId}`, { headers, data: { httpOptions: JSON.stringify({ CURLOPT_PROXY: "http://169.254.169.254:3128" }) } });
    expect(proxy.status()).toBe(422);
    expect((await proxy.json()).error).toContain("private IP");

    db.prepare('UPDATE "Feed" SET allowInternal = 1 WHERE id = ?').run(feedId);
    const synced = await page.request.post(`/api/v1/feeds/${feedId}/sync`, { headers });
    expect(synced.ok()).toBe(true);
    const article = db.prepare('SELECT id FROM "Article" WHERE feedId = ?').get(feedId) as { id: string };
    expect(article).toBeTruthy();

    // Manual full text uses the instance switch; a per-feed opt-in alone
    // intentionally does not authorize arbitrary source-page URLs.
    db.prepare('UPDATE "GlobalSettings" SET allowInternalFeedUrls = 1 WHERE id = ?').run("global");
    const full = await page.request.post(`/api/v1/articles/${article.id}/fetch-full-text`, { headers });
    expect(full.status(), await full.text()).toBe(200);
    const stored = db.prepare('SELECT content FROM "Article" WHERE id = ?').get(article.id) as { content: string };
    expect(stored.content).toContain("preventing a second resolution");
    expect(stored.content.length).toBeGreaterThan(400);
  } finally {
    db.prepare('UPDATE "GlobalSettings" SET allowInternalFeedUrls = ? WHERE id = ?').run(old.allowInternalFeedUrls, "global");
    if (feedId) {
      db.pragma("foreign_keys = ON");
      db.prepare('DELETE FROM "Feed" WHERE id = ?').run(feedId);
    }
    db.close();
  }
});
