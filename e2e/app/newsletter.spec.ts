import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { test, expect } from "../helpers/test";
import { manifest } from "../helpers/db";

// N1 PR B: admin wizard (choose → connect → end-to-end test) and the user's
// newsletter settings. IMAP is the harness-gated fake mailbox
// (lib/inbound-email-fake-imap.ts): a spool dir next to the e2e DB, no network.

const spool = () => `${manifest().dbPath}.imap-spool`;

function resetNewsletterState(userId: string) {
  const db = new Database(manifest().dbPath);
  db.pragma("busy_timeout = 5000");
  try {
    db.prepare('DELETE FROM "InboundMailSource"').run();
    db.prepare('DELETE FROM "NewsletterAddress" WHERE userId = ?').run(userId);
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

    // Step 1: IMAP recommended, the other ways are visible but not yet available.
    await expect(wizard.getByTestId("nl-path-cloudflare")).toBeDisabled();
    await expect(wizard.getByTestId("nl-path-webhook")).toBeDisabled();
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

    deliver(1, address, "Ferret Weekly #1");
    deliver(2, "e2e.box@gmail.com", "A private mail"); // not ours: must stay untouched
    await step.getByTestId("nl-manual-sent").click();
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
  });
});
