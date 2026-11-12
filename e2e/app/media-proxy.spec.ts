import Database from "better-sqlite3";
import { manifest } from "../helpers/db";
import { test, expect } from "../helpers/test";

test("reader loads a signed image through the proxy from the fixture server", async ({ app, page }) => {
  const db = new Database(manifest().dbPath);
  const id = manifest().users[app.userKey].firstArticleId;
  const original = db.prepare('SELECT content, imageUrl, updatedAt FROM "Article" WHERE id = ?').get(id) as { content: string; imageUrl: string | null; updatedAt: number };
  const mode = db.prepare('SELECT mediaProxyMode FROM "GlobalSettings" WHERE id = ?').get("global") as { mediaProxyMode: string } | undefined;
  db.prepare('INSERT INTO "GlobalSettings" (id, mediaProxyMode, updatedAt) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET mediaProxyMode = excluded.mediaProxyMode').run("global", "on", Date.now());
  db.prepare('UPDATE "Article" SET content = ?, imageUrl = NULL WHERE id = ?').run('<p>Media privacy fixture</p><picture><source srcset="http://media.fixture.example/e4.png 1x"><img src="http://media.fixture.example/e4.png" alt="Proxy fixture"></picture>', id);
  try {
    const thirdParty: string[] = [];
    page.on("request", request => { if (request.url().includes("media.fixture.example")) thirdParty.push(request.url()); });
    await app.open();
    await app.activate(app.row(1));
    const image = page.locator('.article-content img[alt="Proxy fixture"]');
    await expect(image).toHaveAttribute("src", /^\/api\/media\?u=/);

    // The publisher URL only appears encoded inside a same-origin request.
    expect(thirdParty.every(url => new URL(url).pathname === "/api/media")).toBe(true);
    const src = await image.getAttribute("src");
    const response = await page.request.get(src!);
    expect(response.status()).toBe(200);
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
    expect(response.headers()["etag"]).toBe('"e4-fixture"');
    expect(response.headers()["content-security-policy"]).toBe("default-src 'none'");
    expect((await page.request.get(src!.replace(/s=[a-f0-9]+/, "s=bad"))).status()).toBe(403);
    const stored = db.prepare('SELECT content, updatedAt FROM "Article" WHERE id = ?').get(id) as { content: string; updatedAt: number };
    expect(stored.content).toContain("http://media.fixture.example/e4.png");
    expect(stored.updatedAt).toBe(original.updatedAt);
  } finally {
    db.prepare('UPDATE "Article" SET content = ?, imageUrl = ? WHERE id = ?').run(original.content, original.imageUrl, id);
    db.prepare('UPDATE "GlobalSettings" SET mediaProxyMode = ? WHERE id = ?').run(mode?.mediaProxyMode ?? "off", "global");
    db.close();
  }
});
