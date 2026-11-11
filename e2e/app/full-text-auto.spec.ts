import Database from "better-sqlite3";
import { ACTIVE_LIST, test, expect } from "../helpers/test";
import { manifest } from "../helpers/db";

// Auto full text (diagnosis R5/R6): the reader shows extracted full text for a
// real article page, keeps the feed teaser when the page is a consent wall,
// and a re-sync of the unchanged feed fetches no page again (no churn).
// Runs against the local fixture server (/ft/*); the instance opt-in for
// internal URLs is enabled only for this test and restored afterwards.

const FIXTURE = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT || 4010}`;

async function hits(tag: string): Promise<{ good: number; wall: number }> {
  return (await fetch(`${FIXTURE}/ft/hits?t=${tag}`)).json();
}

test("auto full text: reader shows extracted text, walls keep the teaser, re-sync does not refetch", async ({ app, page }) => {
  // The reader's boot sync (POST /api/sync on load, components/shell/reader-shell.tsx)
  // must finish before the feed exists: started late, it synced the new feed
  // concurrently with the explicit sync below and fetched each page twice.
  const bootSync = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/sync", { timeout: 15_000 }).catch(() => null);
  await page.goto("/");
  await bootSync;
  const origin = new URL(page.url()).origin;
  const headers = { Origin: origin };
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const feedName = `FT auto ${tag}`;
  const db = new Database(manifest().dbPath);
  db.pragma("busy_timeout = 5000");
  const old = db.prepare('SELECT allowInternalFeedUrls FROM "GlobalSettings" WHERE id = ?').get("global") as { allowInternalFeedUrls: number } | undefined;
  if (!old) db.prepare('INSERT INTO "GlobalSettings" (id, updatedAt) VALUES (?, ?)').run("global", new Date().toISOString());
  let feedId: string | undefined;
  try {
    db.prepare('UPDATE "GlobalSettings" SET allowInternalFeedUrls = 1 WHERE id = ?').run("global");
    const created = await page.request.post("/api/v1/feeds", { headers, data: { url: `${FIXTURE}/ft/feed?t=${tag}`, name: feedName, sync: false } });
    expect(created.status(), await created.text()).toBe(201);
    feedId = (await created.json()).id as string;
    const patched = await page.request.patch(`/api/v1/feeds/${feedId}`, { headers, data: { fullTextMode: "auto" } });
    expect(patched.ok(), await patched.text()).toBe(true);

    const before = await hits(tag);
    const synced = await page.request.post(`/api/v1/feeds/${feedId}/sync`, { headers });
    expect(synced.ok(), await synced.text()).toBe(true);
    const afterFirst = await hits(tag);
    expect(afterFirst.good - before.good).toBe(1);
    expect(afterFirst.wall - before.wall).toBe(1);

    type Row = { id: string; title: string; content: string; feedContent: string | null; fullTextStatus: string | null; fullTextReason: string | null; updatedAt: string };
    const rows = () =>
      db.prepare('SELECT id, title, content, feedContent, fullTextStatus, fullTextReason, updatedAt FROM "Article" WHERE feedId = ? ORDER BY title').all(feedId) as Row[];
    const [good, wall] = rows();
    expect(good.title).toBe("FT good story");
    expect(good.fullTextStatus).toBe("ok");
    expect(good.content).toContain("final enclosure survey");
    expect(good.content).not.toContain("Related: ferret diets");
    expect(good.feedContent).toContain("Teaser: the ferret colony moved.");
    expect(wall.fullTextStatus).toBe("rejected");
    expect(wall.fullTextReason).toBe("consent_wall");
    expect(wall.content).toContain("a walled story stays a teaser");
    expect(wall.feedContent).toBeNull();

    // Unchanged feed: no page is fetched again and nothing is rewritten.
    const resynced = await page.request.post(`/api/v1/feeds/${feedId}/sync`, { headers });
    expect(resynced.ok()).toBe(true);
    expect(await hits(tag)).toEqual(afterFirst);
    expect(rows()).toEqual([good, wall]);

    // The reader (and the REST API) serve the best content.
    const api = await page.request.get(`/api/v1/articles/${good.id}`, { headers });
    expect(api.ok()).toBe(true);
    const payload = await api.json();
    expect(JSON.stringify(payload)).toContain("final enclosure survey");
    expect(JSON.stringify(payload)).not.toContain("feedContent");

    const openArticle = async (id: string, title: string) => {
      await app.open();
      await app.selectSidebar(new RegExp(`^${feedName}`));
      const row = page.locator(`${ACTIVE_LIST} [data-article-id="${id}"] > [role="button"]`);
      await expect(row).toBeVisible();
      await app.activate(row);
      await expect(page.locator("#article-title")).toHaveText(title);
      return page.locator(".article-content").filter({ visible: true }).first();
    };
    const body = await openArticle(good.id, "FT good story");
    await expect(body).toContainText("The final enclosure survey confirmed every ferret settled within a week.");
    await expect(body).not.toContainText("Teaser: the ferret colony moved.");

    const wallBody = await openArticle(wall.id, "FT walled story");
    await expect(wallBody).toContainText("a walled story stays a teaser");
    await expect(wallBody).not.toContainText("Accept all");
  } finally {
    if (old) db.prepare('UPDATE "GlobalSettings" SET allowInternalFeedUrls = ? WHERE id = ?').run(old.allowInternalFeedUrls, "global");
    else db.prepare('DELETE FROM "GlobalSettings" WHERE id = ?').run("global");
    if (feedId) {
      db.pragma("foreign_keys = ON");
      db.prepare('DELETE FROM "Feed" WHERE id = ?').run(feedId);
    }
    db.close();
  }
});
