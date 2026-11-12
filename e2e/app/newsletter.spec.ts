import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { test, expect } from "../helpers/test";
import { manifest } from "../helpers/db";

// N1 PR B/C: admin wizard (choose → connect → end-to-end test) and the user's
// newsletter settings. IMAP is the harness-gated fake mailbox
// (lib/inbound-email-fake-imap.ts): a spool dir next to the e2e DB, no network.
// The Cloudflare / webhook way is driven over real HTTP: the test plays the
// Cloudflare Worker (same HMAC as the generated script) against the running server.

const spool = () => `${manifest().dbPath}.imap-spool`;

function resetNewsletterState(userId: string) {
  const db = new Database(manifest().dbPath);
  db.pragma("busy_timeout = 5000");
  try {
    db.prepare('DELETE FROM "InboundMailSource"').run();
    // Instance-wide: addresses of every user (they decide whether a mailbox change needs confirmation).
    db.prepare('DELETE FROM "NewsletterAddress"').run();
    db.prepare('DELETE FROM "NewsletterQuota" WHERE userId = ?').run(userId);
    // Newsletter items are not part of the seed: other specs reset seeded article state.
    db.prepare(`DELETE FROM "Article" WHERE feedId IN (SELECT id FROM "Feed" WHERE userId = ? AND sourceType = 'newsletter')`).run(userId);
    db.prepare(`DELETE FROM "Feed" WHERE userId = ? AND sourceType = 'newsletter'`).run(userId);
    db.prepare('DELETE FROM "Category" WHERE id = ?').run(`newsletter-folder-${userId}`);
  } finally {
    db.close();
  }
  fs.rmSync(spool(), { recursive: true, force: true });
  fs.mkdirSync(path.join(spool(), "INBOX"), { recursive: true });
}

function deliver(uid: number, to: string, subject: string) {
  const eml = [
    `Delivered-To: ${to}`,
    `To: ${to}`,
    "From: Weekly Ferret <hello@weekly-ferret.example>",
    "List-Id: Weekly Ferret <weekly.ferret.example>",
    `Subject: ${subject}`,
    `Message-ID: <e2e-${uid}-${Date.now()}@weekly-ferret.example>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    `<p>${subject} — hello from the fake mailbox.</p>`,
    "",
  ].join("\r\n");
  fs.writeFileSync(path.join(spool(), "INBOX", `${uid}.eml`), eml);
}

test.describe("newsletter inbox", () => {
  test.beforeEach(({ app }) => resetNewsletterState(app.user.userId));
  test.afterEach(({ app }) => resetNewsletterState(app.user.userId));

  test("settings explain the feature until an admin connects a mailbox", async ({ page }) => {
    await page.goto("/settings/newsletter");
    await expect(page).toHaveURL(/\/settings\?tab=newsletter$/);
    const card = page.getByTestId("newsletter-unavailable");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole("heading", { name: "Newsletter inbox not set up yet" })).toBeVisible();
    // Seeded users are admins: they get the shortcut to the wizard.
    await expect(card.getByTestId("newsletter-setup-link")).toHaveAttribute("href", "/server-settings?tab=newsletter");
  });

  test("admin connects a mailbox in three steps, a test mail arrives, users get addresses", async ({ app, page }) => {
    test.skip(app.isMobile, "one instance-wide wizard run is enough (desktop)");
    test.setTimeout(120_000);

    await page.goto("/server-settings?tab=newsletter");
    const wizard = page.getByTestId("newsletter-inbound");
    await expect(wizard).toBeVisible({ timeout: 20_000 });

    // Step 1: IMAP recommended; the Cloudflare and webhook ways are offered next to it.
    await expect(wizard.getByTestId("nl-path-cloudflare")).toBeEnabled();
    await expect(wizard.getByTestId("nl-path-webhook")).toBeEnabled();
    await wizard.getByTestId("nl-path-imap").click();

    // Step 2: the provider is detected from the address, with its app-password link.
    await wizard.getByLabel("Mailbox e-mail address").fill("e2e.box@gmail.com");
    await expect(wizard.getByTestId("nl-detected")).toContainText("Gmail");
    await expect(wizard.getByTestId("nl-detected")).toContainText("imap.gmail.com:993");
    await expect(wizard.getByTestId("nl-app-password-link")).toHaveAttribute("href", "https://myaccount.google.com/apppasswords");

    // A normal password is refused with a clear hint.
    await wizard.getByLabel("App password").fill("e2e-normal-password");
    await wizard.getByTestId("nl-test-connection").click();
    await expect(wizard.getByTestId("nl-connect-result")).toContainText("requires an app password");

    await wizard.getByLabel("App password").fill("e2e-app-pass");
    await wizard.getByTestId("nl-test-connection").click();
    await expect(wizard.getByTestId("nl-connect-result")).toContainText("Connection works");
    await wizard.getByTestId("nl-save").click();

    // Step 3: no outgoing mail in the harness → manual instructions with the address.
    const step = wizard.getByTestId("nl-test-step");
    await expect(step).toBeVisible();
    const address = (await step.getByTestId("nl-test-address").textContent())!.trim();
    expect(address).toMatch(/^e2e\.box\+ff-[a-z2-7]{26}@gmail\.com$/);
    const marker = (await step.getByTestId("nl-test-marker").textContent())!.trim();
    expect(marker).toMatch(/^FF-TEST-[A-Z2-7]{8}$/);

    deliver(1, address, "Ferret Weekly #1");
    deliver(2, "e2e.box@gmail.com", "A private mail"); // not ours: must stay untouched
    await step.getByTestId("nl-manual-sent").click();
    // Another newsletter arriving is not the test mail: only the marker counts.
    await expect(step.getByTestId("nl-test-status")).toContainText("Waiting for the mail");
    await page.waitForTimeout(9_000);
    await expect(step.getByTestId("nl-test-arrived")).toHaveCount(0);
    deliver(3, address, `Test ${marker}`);
    await expect(step.getByTestId("nl-test-arrived")).toBeVisible({ timeout: 45_000 });

    expect(fs.existsSync(path.join(spool(), "FeedFerret", "1.eml"))).toBe(true);
    expect(fs.existsSync(path.join(spool(), "INBOX", "2.eml"))).toBe(true);

    // The newsletter became an article in the auto-created "Newsletter" folder.
    const db = new Database(manifest().dbPath);
    try {
      const row = db
        .prepare('SELECT a.title, f.sourceType, c.name AS folder FROM "Article" a JOIN "Feed" f ON f.id = a.feedId LEFT JOIN "Category" c ON c.id = f.categoryId WHERE a.userId = ? AND a.title = ?')
        .get(app.user.userId, "Ferret Weekly #1");
      expect(row).toEqual({ title: "Ferret Weekly #1", sourceType: "newsletter", folder: "Newsletter" });
    } finally {
      db.close();
    }

    // Status card afterwards.
    await step.getByTestId("nl-test-skip").click();
    const status = wizard.getByTestId("nl-status-card");
    await expect(status).toBeVisible();
    await expect(status.getByTestId("nl-status-badge")).toHaveText("Running");
    await expect(status.getByTestId("nl-last-mail")).not.toHaveText("never");
    await expect(status.getByTestId("nl-error-count")).toHaveText("0");
    await status.getByTestId("nl-status-pause").click();
    await expect(status.getByTestId("nl-status-badge")).toHaveText("Paused");
    await status.getByTestId("nl-status-pause").click();
    await expect(status.getByTestId("nl-status-badge")).toHaveText("Running");
    // The password never reaches the browser.
    expect(await page.content()).not.toContain("e2e-app-pass");

    // User page: the same address, plus an extra one that can be switched off.
    await page.goto("/settings?tab=newsletter");
    await expect(page.getByTestId("newsletter-address")).toHaveText(address, { timeout: 20_000 });
    await page.getByPlaceholder(/What for\?/).fill("Substack");
    await page.getByTestId("newsletter-create").click();
    const rows = page.getByTestId("newsletter-address-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText("Substack");
    await rows.nth(1).getByTestId("newsletter-toggle").click();
    await expect(rows.nth(1)).toHaveAttribute("data-active", "0");
    await expect(rows.nth(1)).toContainText("Deactivated");

    // A different mailbox changes every address: the server insists on a confirmation.
    await page.goto("/server-settings?tab=newsletter");
    const card = page.getByTestId("nl-status-card");
    await card.getByTestId("nl-status-edit").click();
    await wizard.getByLabel("Mailbox e-mail address").fill("e2e.other@gmail.com");
    await wizard.getByLabel("App password").fill("e2e-app-pass");
    await wizard.getByTestId("nl-save").click();
    const confirm = page.getByTestId("nl-confirm-change");
    await expect(confirm).toContainText("every user's address changes");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(wizard.getByTestId("nl-test-step")).toHaveCount(0);

    // Disconnect warns the same way.
    await wizard.getByRole("button", { name: "Back" }).click();
    await card.getByTestId("nl-status-disconnect").click();
    await expect(page.getByRole("alertdialog")).toContainText("New newsletters stop arriving until a mailbox is connected");
    await page.getByTestId("nl-disconnect-confirm").click();
    await expect(wizard.getByTestId("nl-path-imap")).toBeVisible();

    // Reconnecting the SAME mailbox keeps every address: no confirmation.
    await wizard.getByTestId("nl-path-imap").click();
    await wizard.getByLabel("Mailbox e-mail address").fill("e2e.box@gmail.com");
    await wizard.getByLabel("App password").fill("e2e-app-pass");
    await wizard.getByTestId("nl-save").click();
    await expect(wizard.getByTestId("nl-test-step")).toBeVisible();
    await expect(page.getByTestId("nl-confirm-change")).toHaveCount(0);
    await page.goto("/settings?tab=newsletter");
    await expect(page.getByTestId("newsletter-address")).toHaveText(address, { timeout: 20_000 });
  });

  test("Cloudflare way: the secret is shown once, a signed worker request becomes an article, rotation and pause lock the old script out", async ({ app, page, request }) => {
    test.skip(app.isMobile, "one instance-wide wizard run is enough (desktop)");
    test.setTimeout(120_000);
    // Each attempt (retries!) is its own "client" for the webhook's per-IP limits.
    const client = () => ({ "x-forwarded-for": `198.51.100.${1 + Math.floor(Math.random() * 250)}` });

    await page.goto("/server-settings?tab=newsletter");
    const wizard = page.getByTestId("newsletter-inbound");
    await expect(wizard).toBeVisible({ timeout: 20_000 });
    await wizard.getByTestId("nl-path-cloudflare").click();

    // A bad domain is refused with a hint; nothing is stored.
    await wizard.getByLabel("Domain for the newsletter addresses").fill("https://nope");
    await wizard.getByTestId("nl-save").click();
    await expect(wizard.getByTestId("nl-connect-result")).toContainText("Please enter a domain like");
    await wizard.getByLabel("Domain for the newsletter addresses").fill("News.E2E.example");
    await wizard.getByTestId("nl-save").click();

    // The worker script comes with URL and secret already filled in; the secret is shown once.
    await expect(wizard.getByTestId("nl-secret-once")).toBeVisible();
    await expect(wizard.getByTestId("nl-cf-steps").locator("li")).toHaveCount(4);
    const script = (await wizard.getByTestId("nl-worker-script").textContent())!;
    expect(script).not.toContain("__FEEDFERRET");
    const endpoint = /const WEBHOOK_URL = "([^"]+)";/.exec(script)![1];
    const secret = /const WEBHOOK_SECRET = "([0-9a-f]{64})";/.exec(script)![1];
    expect(endpoint).toMatch(/\/api\/webhooks\/inbound-email\/[a-z0-9]+$/);
    await wizard.getByTestId("nl-setup-continue").click();

    const step = wizard.getByTestId("nl-test-step");
    const address = (await step.getByTestId("nl-test-address").textContent())!.trim();
    expect(address).toMatch(/^[a-z2-7]{26}@news\.e2e\.example$/);
    const marker = (await step.getByTestId("nl-test-marker").textContent())!.trim();

    const sign = (key: string, body: string, to: string, ts = Math.floor(Date.now() / 1000)) => ({
      "content-type": "message/rfc822",
      "x-feedferret-timestamp": String(ts),
      "x-feedferret-recipient": to,
      "x-feedferret-signature": `sha256=${createHmac("sha256", key).update(`${ts}\n${to}\n${body}`).digest("hex")}`,
    });
    const mail = (to: string, subject: string, id: string) =>
      [
        "From: Weekly Ferret <hello@weekly-ferret.example>",
        `To: ${to}`,
        "List-Id: Weekly Ferret <weekly.ferret.example>",
        `Subject: ${subject}`,
        `Message-ID: <${id}@weekly-ferret.example>`,
        `Date: ${new Date().toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
        "",
        `<p>${subject} - pushed by the worker.</p>`,
        "",
      ].join("\r\n");
    const post = (body: string, headers: Record<string, string>) => request.post(endpoint, { headers: { ...client(), ...headers }, data: Buffer.from(body) });

    // Outsiders: no / wrong / forged / replayed signatures never get a mail in.
    const probe = mail(address, "Should not arrive", "probe-1");
    expect((await post(probe, { "content-type": "message/rfc822" })).status()).toBe(401);
    expect((await post(probe, sign("00".repeat(32), probe, address))).status()).toBe(401);
    expect((await post(probe, { ...sign(secret, probe, address), "x-feedferret-recipient": "other@news.e2e.example" })).status()).toBe(401);
    const stale = await post(probe, sign(secret, probe, address, Math.floor(Date.now() / 1000) - 3600));
    expect(stale.status()).toBe(401);
    expect(await stale.json()).toEqual({ error: "timestamp-out-of-window" });

    // The worker's request: stored, deduplicated, counted in the status card.
    const testMail = mail(address, `Test ${marker}`, "marker-1");
    const ok = await post(testMail, sign(secret, testMail, address));
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, status: "created" });
    expect(await (await post(testMail, sign(secret, testMail, address))).json()).toMatchObject({ status: "duplicate" });
    await step.getByTestId("nl-manual-sent").click();
    await expect(step.getByTestId("nl-test-arrived")).toBeVisible({ timeout: 45_000 });

    const db = new Database(manifest().dbPath);
    try {
      const rows = db
        .prepare('SELECT a.title, f.sourceType, c.name AS folder FROM "Article" a JOIN "Feed" f ON f.id = a.feedId LEFT JOIN "Category" c ON c.id = f.categoryId WHERE a.userId = ?  AND f.sourceType = \'newsletter\'')
        .all(app.user.userId);
      expect(rows).toEqual([{ title: `Test ${marker}`, sourceType: "newsletter", folder: "Newsletter" }]);
    } finally {
      db.close();
    }

    // Postmark-style: JSON + the secret as Basic password in the URL.
    const postmark = JSON.stringify({ From: "News <news@postmark-news.example>", OriginalRecipient: address, Subject: "Via Postmark", TextBody: "hello", HtmlBody: "<p>hello</p>", MessageID: "11111111-2222-3333-4444-555555555555" });
    const basic = (pw: string) => `Basic ${Buffer.from(`feedferret:${pw}`).toString("base64")}`;
    const wrong = await request.post(endpoint, { headers: { ...client(), "content-type": "application/json", authorization: basic("nope") }, data: postmark });
    expect(wrong.status()).toBe(401);
    const viaBasic = await request.post(endpoint, { headers: { ...client(), "content-type": "application/json", authorization: basic(secret) }, data: postmark });
    expect(viaBasic.status()).toBe(200);
    expect(await viaBasic.json()).toMatchObject({ status: "created", format: "postmark" });

    // Status card: way, domain, endpoint (no secret), activity.
    await step.getByTestId("nl-test-skip").click();
    const status = wizard.getByTestId("nl-status-card");
    await expect(status.getByTestId("nl-status-path")).toHaveText("Cloudflare Email Routing");
    await expect(status.getByTestId("nl-status-badge")).toHaveText("Running");
    await expect(status.getByTestId("nl-last-mail")).not.toHaveText("never");
    await expect(status.getByTestId("nl-status-endpoint")).toHaveText(endpoint);
    expect(await page.content()).not.toContain(secret);
    await page.reload();
    await expect(wizard.getByTestId("nl-status-card")).toBeVisible({ timeout: 20_000 });
    expect(await page.content()).not.toContain(secret);

    // Users get <token>@domain addresses.
    await page.goto("/settings?tab=newsletter");
    await expect(page.getByTestId("newsletter-address")).toHaveText(address, { timeout: 20_000 });

    // Paused: the endpoint answers 403 (Postmark stops retrying), resumed: works again.
    await page.goto("/server-settings?tab=newsletter");
    await wizard.getByTestId("nl-status-pause").click();
    await expect(wizard.getByTestId("nl-status-badge")).toHaveText("Paused");
    const paused = mail(address, "While paused", "paused-1");
    expect((await post(paused, sign(secret, paused, address))).status()).toBe(403);
    await wizard.getByTestId("nl-status-pause").click();
    await expect(wizard.getByTestId("nl-status-badge")).toHaveText("Running");

    // Rotation: the old script is locked out, the new one works, addresses stay.
    await wizard.getByTestId("nl-status-edit").click();
    await expect(wizard.getByTestId("nl-rotate-warning")).toBeVisible();
    await wizard.getByTestId("nl-save").click();
    const fresh = /const WEBHOOK_SECRET = "([0-9a-f]{64})";/.exec((await wizard.getByTestId("nl-worker-script").textContent())!)![1];
    expect(fresh).not.toBe(secret);
    const later = mail(address, "After rotation", "rot-1");
    expect((await post(later, sign(secret, later, address))).status()).toBe(401);
    expect((await post(later, sign(fresh, later, address))).status()).toBe(200);
    await wizard.getByTestId("nl-setup-continue").click();
    await wizard.getByTestId("nl-test-skip").click();

    // Disconnect wipes the secret: even the right one is refused now.
    await wizard.getByTestId("nl-status-disconnect").click();
    await page.getByTestId("nl-disconnect-confirm").click();
    await expect(wizard.getByTestId("nl-path-cloudflare")).toBeVisible();
    const gone = mail(address, "After disconnect", "gone-1");
    expect((await post(gone, sign(fresh, gone, address))).status()).toBe(404);
  });

  test("webhook way shows the endpoint, both Basic-auth and plain URL, and Postmark / Mailgun steps", async ({ app, page }) => {
    test.skip(app.isMobile, "one instance-wide wizard run is enough (desktop)");
    await page.goto("/server-settings?tab=newsletter");
    const wizard = page.getByTestId("newsletter-inbound");
    await expect(wizard).toBeVisible({ timeout: 20_000 });
    await wizard.getByTestId("nl-path-webhook").click();
    await wizard.getByLabel("Domain for the newsletter addresses").fill("inbox.e2e.example");
    await wizard.getByTestId("nl-save").click();
    const withAuth = (await wizard.getByTestId("nl-webhook-url-auth").textContent())!;
    const plain = (await wizard.getByTestId("nl-webhook-url").textContent())!;
    expect(plain).toMatch(/\/api\/webhooks\/inbound-email\/[a-z0-9]+$/);
    expect(withAuth).toMatch(/^https?:\/\/feedferret:[0-9a-f]{64}@/);
    expect(withAuth.replace(/\/\/feedferret:[0-9a-f]{64}@/, "//")).toBe(plain);
    await expect(wizard.getByTestId("nl-setup-webhook")).toContainText("Postmark");
    await expect(wizard.getByTestId("nl-setup-webhook")).toContainText("Mailgun");
    await wizard.getByTestId("nl-setup-continue").click();
    await expect(wizard.getByTestId("nl-test-step")).toBeVisible();
  });
});
