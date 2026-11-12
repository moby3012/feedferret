import Database from "better-sqlite3";
import { test, expect, openSettingsSection } from "../helpers/test";
import { manifest, setUserColumns, userColumns } from "../helpers/db";
import { openForE2e, sealForE2e } from "../helpers/secrets";

// M8 (security audit #2): the app reads v2-sealed secrets, writes every secret
// v2-sealed (PR 5) and never sends stored secrets to the browser.

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
    // Written v2-sealed (M8 PR 5), never in the clear.
    expect(openForE2e("user.gotifyToken", userColumns({ userKey: app.userKey }, ["gotifyToken"]).gotifyToken)).toBe("E2E-NEW-GOTIFY");
    await expect(page.locator("#gotify-app-token")).toHaveValue("");
    expect(await page.content()).not.toContain("E2E-NEW-GOTIFY");
  } finally {
    restore();
  }
});

test("rules: webhook secret and header values never reach the browser; editing keeps them", async ({ app, page }) => {
  const db = new Database(manifest().dbPath);
  db.pragma("busy_timeout = 5000");
  const ruleId = `e2e-m8-rule-${app.userKey}-${Date.now().toString(36)}`;
  const secret = `E2E-WEBHOOK-SECRET-${app.userKey}`;
  const header = `Bearer E2E-WEBHOOK-HEADER-${app.userKey}`;
  const stored = JSON.stringify([{ url: "https://hook.e2e.test/x", method: "POST", headers: { Authorization: sealForE2e("autoReadRule.webhookConfigs.header", header) }, secret }]);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO "AutoReadRule" (id, userId, name, query, action, actions, webhookConfigs, enabled, "order", trigger, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 'article', ?, ?)`).run(
    ruleId, app.user.userId, "E2E webhook rule", "e2e-never-matches-xyz", "webhook_call:0", JSON.stringify(["webhook_call:0"]), stored, now, now,
  );
  try {
    const bodies: string[] = [];
    page.on("response", async (response) => {
      if (response.request().method() === "POST" && response.request().headers()["next-action"]) bodies.push(await response.text().catch(() => ""));
    });
    await page.goto("/manage-feeds?tab=rules");
    const ruleRow = page.getByText("E2E webhook rule").first();
    await expect(ruleRow).toBeVisible({ timeout: 20_000 });
    const forbidden = [secret, header, "E2E-WEBHOOK-HEADER", "ff2."];
    for (const text of [await page.content(), ...bodies]) for (const value of forbidden) expect(text).not.toContain(value);

    // Edit and save without touching the webhook: secret and header stay as stored.
    await page.getByTitle("Edit rule").first().click();
    await page.getByRole("button", { name: "Save changes" }).first().click();
    await expect.poll(() => (db.prepare('SELECT updatedAt FROM "AutoReadRule" WHERE id = ?').get(ruleId) as { updatedAt: string }).updatedAt).not.toBe(now);
    const afterRaw = (db.prepare('SELECT webhookConfigs FROM "AutoReadRule" WHERE id = ?').get(ruleId) as { webhookConfigs: string }).webhookConfigs;
    expect(afterRaw).not.toContain(secret); // the legacy plaintext secret got sealed on save (M8 PR 5)
    const after = JSON.parse(afterRaw);
    expect(after[0]).toMatchObject({ url: "https://hook.e2e.test/x", method: "POST" });
    expect(openForE2e("autoReadRule.webhookConfigs.secret", after[0].secret)).toBe(secret);
    expect(openForE2e("autoReadRule.webhookConfigs.header", after[0].headers.Authorization)).toBe(header);
    for (const body of bodies) for (const value of forbidden) expect(body).not.toContain(value);
  } finally {
    db.prepare('DELETE FROM "AutoReadRule" WHERE id = ?').run(ruleId);
    db.close();
  }
});

test("feed edit dialog: fetch options with credentials are masked; saving keeps them", async ({ app, page }) => {
  const db = new Database(manifest().dbPath);
  db.pragma("busy_timeout = 5000");
  const feed = db.prepare('SELECT id, name, httpOptions FROM "Feed" WHERE userId = ? AND name = ?').get(app.user.userId, "Solo Blog") as { id: string; name: string; httpOptions: string | null };
  const cookie = `sid=E2E-COOKIE-${app.userKey}`;
  const options = { CURLOPT_COOKIE: cookie, CURLOPT_HTTPHEADER: "Authorization: Bearer E2E-OPT-HEADER", CURLOPT_USERAGENT: "E2E-UA" };
  db.prepare('UPDATE "Feed" SET httpOptions = ? WHERE id = ?').run(sealForE2e("feed.httpOptions", JSON.stringify(options)), feed.id);
  try {
    await page.goto("/manage-feeds");
    const row = page.getByText("http://127.0.0.1:" + (process.env.E2E_FIXTURE_PORT || 4010) + "/feeds/solo-blog.xml").locator("xpath=ancestor::*[.//button[normalize-space()='Settings']][1]");
    await app.activate(row.getByRole("button", { name: "Settings" }));
    const dialog = page.getByRole("dialog");
    await app.activate(dialog.getByRole("tab", { name: "Scout Studio" }));
    await expect(dialog.getByTestId("http-options-masked-hint")).toContainText("CURLOPT_COOKIE, CURLOPT_HTTPHEADER");
    const textarea = dialog.getByPlaceholder(/CURLOPT_HTTPHEADER/);
    await expect(textarea).toHaveValue(JSON.stringify({ CURLOPT_COOKIE: "__keep__", CURLOPT_HTTPHEADER: "__keep__", CURLOPT_USERAGENT: "E2E-UA" }));
    const dom = await page.content();
    for (const value of ["E2E-COOKIE", "E2E-OPT-HEADER", "ff2."]) expect(dom).not.toContain(value);

    const storedNow = () => (db.prepare('SELECT httpOptions FROM "Feed" WHERE id = ?').get(feed.id) as { httpOptions: string });
    const sealedBefore = storedNow().httpOptions;
    await app.activate(dialog.getByRole("button", { name: "Save settings" }));
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => storedNow().httpOptions).not.toBe(sealedBefore); // re-saved (fresh IV)
    const saved = JSON.parse(openForE2e("feed.httpOptions", storedNow().httpOptions));
    expect(saved).toEqual(options); // kept server-side; written v2-sealed (M8 PR 5)
  } finally {
    db.prepare('UPDATE "Feed" SET httpOptions = ? WHERE id = ?').run(feed.httpOptions, feed.id);
    db.close();
  }
});

test("AI settings: a saved API key is stored v2-sealed and never sent back", async ({ app, page, isMobile }) => {
  const key = `sk-E2E-AI-${app.userKey}`;
  const restore = setUserColumns(app.userKey, { aiProvider: "openai", aiApiKey: null });
  try {
    await openSettingsSection(page, isMobile, "Integrations");
    const section = page.locator("section").filter({ has: page.locator("#ai-api-key-input") }).last(); // innermost: the AI card
    await section.locator("#ai-api-key-input").fill(key);
    await section.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => userColumns({ userKey: app.userKey }, ["aiApiKey"]).aiApiKey).not.toBeNull();
    const stored = userColumns({ userKey: app.userKey }, ["aiApiKey"]).aiApiKey as string;
    expect(stored.startsWith("ff2.")).toBe(true);
    expect(openForE2e("user.aiApiKey", stored)).toBe(key);

    await openSettingsSection(page, isMobile, "Integrations");
    await expect(page.locator("#ai-api-key-input")).toHaveAttribute("placeholder", "Leave blank to keep existing key");
    const dom = await page.content();
    expect(dom).not.toContain(key);
    expect(dom).not.toContain("ff2.");
  } finally {
    restore();
  }
});
