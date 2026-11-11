import Database from "better-sqlite3";
import { test, expect, openSettingsSection } from "../helpers/test";
import { manifest, setUserColumns, userColumns } from "../helpers/db";
import { sealForE2e } from "../helpers/secrets";

// M8 (security audit #2): the app reads v2-sealed secrets (this release still
// writes the legacy format) and never sends stored secrets to the browser.

test("a feed behind HTTP Basic auth syncs with v2-sealed credentials", async ({ app, page }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const fixture = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT || 4010}`;
  const headers = { Origin: origin };
  const db = new Database(manifest().dbPath);
  db.pragma("busy_timeout = 5000");
  const old = db.prepare('SELECT allowInternalFeedUrls FROM "GlobalSettings" WHERE id = ?').get("global") as { allowInternalFeedUrls: number } | undefined;
  if (!old) db.prepare('INSERT INTO "GlobalSettings" (id, updatedAt) VALUES (?, ?)').run("global", new Date().toISOString());
  db.prepare('UPDATE "GlobalSettings" SET allowInternalFeedUrls = 1 WHERE id = ?').run("global");
  let feedId: string | undefined;
  try {
    const created = await page.request.post("/api/v1/feeds", { headers, data: { url: `${fixture}/auth/feed.xml?u=${app.user.userId}`, name: "Auth fixture", sync: false } });
    expect(created.status(), await created.text()).toBe(201);
    feedId = (await created.json()).id as string;

    // Without credentials the fixture answers 401: nothing arrives.
    await page.request.post(`/api/v1/feeds/${feedId}/sync`, { headers });
    expect(db.prepare('SELECT COUNT(*) AS n FROM "Article" WHERE feedId = ?').get(feedId)).toEqual({ n: 0 });

    // Credentials stored in the new v2 format (as the next release writes them).
    db.prepare('UPDATE "Feed" SET authType = ?, authUsername = ?, authPassword = ? WHERE id = ?').run(
      "basic", sealForE2e("feed.authUsername", "e2e-feed-user"), sealForE2e("feed.authPassword", "e2e:feed-pass"), feedId,
    );
    const synced = await page.request.post(`/api/v1/feeds/${feedId}/sync`, { headers });
    expect(synced.ok(), await synced.text()).toBe(true);
    const article = db.prepare('SELECT title FROM "Article" WHERE feedId = ?').get(feedId) as { title: string } | undefined;
    expect(article?.title).toBe("Behind basic auth");

    // The API shows the decrypted username, never the password or ciphertext.
    const feed = await (await page.request.get(`/api/v1/feeds/${feedId}`, { headers })).text();
    expect(feed).toContain("e2e-feed-user");
    expect(feed).not.toContain("e2e:feed-pass");
    expect(feed).not.toContain("ff2.");
    const html = await (await page.request.get("/")).text();
    expect(html).not.toContain("ff2.");
    expect(html).not.toContain("e2e:feed-pass");
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

test("notification settings: tokens are write-only (presence only), keep on save, remove, replace", async ({ app, page, isMobile }) => {
  const telegram = `123456:E2E-TG-${app.userKey}`;
  const gotify = `E2E-GOTIFY-${app.userKey}`;
  const restore = setUserColumns(app.userKey, {
    telegramEnabled: 1, telegramChatId: "4242", telegramBotToken: sealForE2e("user.telegramBotToken", telegram),
    gotifyEnabled: 1, gotifyUrl: "https://gotify.e2e.test", gotifyToken: gotify,
    ntfyEnabled: 0, ntfyUrl: null, ntfyToken: null,
  });
  try {
    const before = userColumns({ userKey: app.userKey }, ["telegramBotToken", "gotifyToken"]);
    const serverActionBodies: string[] = [];
    page.on("response", async (response) => {
      if (response.request().method() === "POST" && response.request().headers()["next-action"]) {
        serverActionBodies.push(await response.text().catch(() => ""));
      }
    });
    await openSettingsSection(page, isMobile, "Notifications");
    const tokenInput = page.locator("#telegram-bot-token");
    await expect(tokenInput).toHaveValue("");
    await expect(tokenInput).toHaveAttribute("placeholder", "Saved — leave empty to keep it");
    await expect(page.locator("#telegram-chat-id")).toHaveValue("4242");
    const dom = await page.content();
    for (const secret of [telegram, gotify, "ff2."]) expect(dom).not.toContain(secret);
    for (const body of serverActionBodies) for (const secret of [telegram, gotify, "ff2."]) expect(body).not.toContain(secret);

    // Save without touching the tokens keeps both stored values verbatim.
    await page.getByRole("button", { name: "Save channels" }).click();
    await expect.poll(() => userColumns({ userKey: app.userKey }, ["telegramChatId"]).telegramChatId).toBe("4242");
    await page.waitForTimeout(300);
    expect(userColumns({ userKey: app.userKey }, ["telegramBotToken", "gotifyToken"])).toEqual(before);

    // Remove the Telegram token, replace the Gotify one.
    await page.locator("#telegram-bot-token").locator("xpath=..").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("The saved token will be removed when you save.")).toBeVisible();
    await page.locator("#gotify-app-token").fill("E2E-NEW-GOTIFY");
    await page.getByRole("button", { name: "Save channels" }).click();
    await expect.poll(() => userColumns({ userKey: app.userKey }, ["telegramBotToken"]).telegramBotToken).toBeNull();
    // This release still writes the legacy (plaintext) format.
    expect(userColumns({ userKey: app.userKey }, ["gotifyToken"]).gotifyToken).toBe("E2E-NEW-GOTIFY");
    await expect(page.locator("#gotify-app-token")).toHaveValue("");
    expect(await page.content()).not.toContain("E2E-NEW-GOTIFY");
  } finally {
    restore();
  }
});
