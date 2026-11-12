import Database from "better-sqlite3";
import { manifest } from "../helpers/db";
import { test, expect } from "../helpers/test";

test("reader loads a signed image through the proxy from the fixture server", async ({ app, page }) => {
  const db = new Database(manifest().dbPath);
  const id = manifest().users[app.userKey].firstArticleId;
  const original = db.prepare('SELECT content, imageUrl, updatedAt FROM "Article" WHERE id = ?').get(id) as { content: string; imageUrl: string | null; updatedAt: number };
  const mode = db.prepare('SELECT mediaProxyMode FROM "GlobalSettings" WHERE id = ?').get("global") as { mediaProxyMode: string } | undefined;
  db.prepare('UPDATE "Article" SET content = ?, imageUrl = NULL WHERE id = ?').run('<p>Media privacy fixture</p><picture><source srcset="http://media.fixture.example/e4.png 1x"><img src="http://media.fixture.example/e4.png" alt="Proxy fixture"></picture><input type="image" src="http://media.fixture.example/e4.png" alt="Proxy button"><video src="/media-fixture.mp4" autoplay preload="auto"><source src="/media-fixture.webm"></video>', id);
  async function setMode(value: string) {
    await page.goto("/server-settings?tab=sync");
    const select = page.locator("#media-proxy-mode");
    const label = value === "on" ? "Always on" : value === "opt-in" ? "Opt-in" : "Off";
    if ((await select.textContent())?.trim() === label) return;
    await select.click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
  }
  try {
    // Use the real settings write so the 30-second read cache invalidates.
    await setMode("on");
    const thirdParty: string[] = [];
    page.on("request", request => { if (request.url().includes("media.fixture.example")) thirdParty.push(request.url()); });
    await app.open();
    await app.activate(app.row(1));
    const image = page.locator('.article-content img[alt="Proxy fixture"]');
    await expect(image).toHaveAttribute("src", /^\/api\/media\?u=/);

    // The publisher URL only appears encoded inside a same-origin request.
    expect(thirdParty.every(url => new URL(url).pathname === "/api/media")).toBe(true);
    await expect(page.locator('.article-content input[type="image"]')).toHaveAttribute("src", /^\/api\/media\?u=/);
    await expect(page.locator(".article-content video")).toHaveAttribute("preload", "none");
    await expect(page.locator(".article-content video")).not.toHaveAttribute("autoplay");
    const src = await image.getAttribute("src");
    const response = await page.request.get(src!);
    expect(response.status()).toBe(200);
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
    expect(response.headers()["cache-control"]).toBe("private, max-age=604800, immutable");
    expect(response.headers()["content-type"]).toBe("image/png");
    expect(response.headers()["etag"]).toBe('"e4-fixture"');
    expect(response.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect((await page.request.get(src!.replace(/s=[a-f0-9]+/, "s=bad"))).status()).toBe(403);
    const stored = db.prepare('SELECT content, updatedAt FROM "Article" WHERE id = ?').get(id) as { content: string; updatedAt: number };
    expect(stored.content).toContain("http://media.fixture.example/e4.png");
    expect(stored.updatedAt).toBe(original.updatedAt);
  } finally {
    db.prepare('UPDATE "Article" SET content = ?, imageUrl = ? WHERE id = ?').run(original.content, original.imageUrl, id);
    db.close();
    await setMode(mode?.mediaProxyMode ?? "off");
  }
});
