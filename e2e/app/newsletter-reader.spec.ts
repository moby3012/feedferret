import Database from "better-sqlite3";
import { ACTIVE_LIST, test, expect } from "../helpers/test";
import type { App } from "../helpers/test";
import { manifest } from "../helpers/db";

// N1 PR D: newsletter articles in the reader — e-mail meta line, double-opt-in
// banner (opened only by a click), "Sender not verified", RFC 8058 one-click
// unsubscribe against the local fixture server, "Block address", and the
// newsletter feed menu (envelope icon, no refresh / health).
//
// Every test inserts its own newsletter feed / article / addresses with
// unique ids and removes them again: the seeded state is never touched.

const FIXTURE = `http://127.0.0.1:${Number(process.env.E2E_FIXTURE_PORT || 4010)}`;

function open() {
  const db = new Database(manifest().dbPath);
  db.pragma("busy_timeout = 5000");
  return db;
}
const iso = (d: Date) => d.toISOString().replace("Z", "+00:00");

type Seeded = { tag: string; feedId: string; feedName: string; articleId: string; title: string; aliasId: string; cleanup: () => void };

function seedNewsletter(userId: string, opts: { auth?: "pass" | "fail" | "none"; confirm?: boolean; oneClick?: boolean; dedicatedAddress?: boolean } = {}): Seeded {
  const tag = `nlr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const feedId = `e2e-${tag}-feed`;
  const articleId = `e2e-${tag}-article`;
  const sourceId = `e2e-${tag}-source`;
  const primaryId = `e2e-${tag}-primary`;
  const aliasId = `e2e-${tag}-alias`;
  const feedName = `Ferret Weekly ${tag}`;
  const title = `Please confirm ${tag}`;
  const now = new Date();
  const db = open();
  try {
    db.prepare(`INSERT INTO "Feed" (id, url, name, userId, sourceType, htmlUrl, newsletterSender, lastStatus, updatedAt) VALUES (?, ?, ?, ?, 'newsletter', NULL, ?, 'ok', ?)`).run(
      feedId,
      `newsletter:list:${tag}.example`,
      feedName,
      userId,
      `list:${tag}.example`,
      iso(now),
    );
    if (opts.dedicatedAddress) {
      // Addresses derive from an inbound source; paused, and the e2e server runs without background sync.
      db.prepare(`INSERT INTO "InboundMailSource" (id, kind, address, paused, createdAt, updatedAt) VALUES (?, 'imap', 'box@example.com', 1, ?, ?)`).run(sourceId, iso(new Date(0)), iso(now));
      // Oldest active = the user's primary address (kept); the alias is the dedicated one.
      db.prepare(`INSERT INTO "NewsletterAddress" (id, userId, token, isActive, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`).run(primaryId, userId, `${tag}primary`.padEnd(26, "a"), iso(new Date(1000)), iso(now));
      db.prepare(`INSERT INTO "NewsletterAddress" (id, userId, token, isActive, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`).run(aliasId, userId, `${tag}alias`.padEnd(26, "b"), iso(new Date(2000)), iso(now));
    }
    db.prepare(
      `INSERT INTO "Article" (id, feedId, userId, title, link, content, contentFormat, excerpt, author, publishedAt, createdAt, updatedAt,
        emailMessageId, emailSender, confirmationUrl, listUnsubscribeUrl, listUnsubscribeMailto, listUnsubscribeOneClick, newsletterAuth, newsletterAddressId, dedupeKey)
       VALUES (?, ?, ?, ?, ?, ?, 'html', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      articleId,
      feedId,
      userId,
      title,
      `newsletter:list:${tag}.example#email`,
      `<p>Hello from the ${tag} newsletter.</p>`,
      "Hello from the newsletter.",
      "Ferret Weekly",
      iso(new Date(now.getTime() - 60_000)),
      iso(now),
      iso(now),
      `${tag}@example.com`,
      "hello@ferret-weekly.example",
      opts.confirm ? `${FIXTURE}/newsletter/confirm/${tag}` : null,
      `${FIXTURE}/newsletter/unsubscribe/${tag}`,
      "mailto:leave@ferret-weekly.example?subject=unsubscribe",
      opts.oneClick === false ? 0 : 1,
      opts.auth ?? "none",
      opts.dedicatedAddress ? aliasId : null,
      `email:${tag}@example.com`,
    );
  } finally {
    db.close();
  }
  return {
    tag,
    feedId,
    feedName,
    articleId,
    title,
    aliasId,
    cleanup: () => {
      const c = open();
      try {
        c.prepare(`DELETE FROM "Article" WHERE feedId = ?`).run(feedId);
        c.prepare(`DELETE FROM "Feed" WHERE id = ?`).run(feedId);
        c.prepare(`DELETE FROM "NewsletterAddress" WHERE id IN (?, ?)`).run(primaryId, aliasId);
        c.prepare(`DELETE FROM "InboundMailSource" WHERE id = ?`).run(sourceId);
      } finally {
        c.close();
      }
    },
  };
}

/** The one-click POST goes to the fixture server on 127.0.0.1: allow internal targets for this test only. */
function allowInternalTargets(): () => void {
  const db = open();
  try {
    const old = db.prepare('SELECT allowInternalFeedUrls FROM "GlobalSettings" WHERE id = ?').get("global") as { allowInternalFeedUrls: number } | undefined;
    if (old) db.prepare('UPDATE "GlobalSettings" SET allowInternalFeedUrls = 1 WHERE id = ?').run("global");
    else db.prepare('INSERT INTO "GlobalSettings" (id, updatedAt, allowInternalFeedUrls) VALUES (?, ?, 1)').run("global", new Date().toISOString());
    return () => {
      const c = open();
      try {
        if (old) c.prepare('UPDATE "GlobalSettings" SET allowInternalFeedUrls = ? WHERE id = ?').run(old.allowInternalFeedUrls, "global");
        else c.prepare('DELETE FROM "GlobalSettings" WHERE id = ?').run("global");
      } finally {
        c.close();
      }
    };
  } finally {
    db.close();
  }
}

function feedExists(id: string): boolean {
  const db = open();
  try {
    return !!db.prepare(`SELECT 1 FROM "Feed" WHERE id = ?`).get(id);
  } finally {
    db.close();
  }
}

function addressActive(id: string): boolean {
  const db = open();
  try {
    return (db.prepare(`SELECT isActive FROM "NewsletterAddress" WHERE id = ?`).get(id) as { isActive: number } | undefined)?.isActive === 1;
  } finally {
    db.close();
  }
}

async function fixtureLog(tag: string): Promise<{ posts: Array<{ body: string; contentType: string | null; cookie: string | null }>; gets: string[]; confirms: number }> {
  const res = await fetch(`${FIXTURE}/newsletter/log/${tag}`);
  return res.json();
}

async function openNewsletter(app: App, seeded: Seeded) {
  await app.open();
  await app.selectSidebar(new RegExp(`^${seeded.feedName}`));
  const row = app.page.locator(`${ACTIVE_LIST} [data-article-id="${seeded.articleId}"] > [role="button"]`);
  await expect(row).toBeVisible();
  await app.activate(row);
  await expect(app.page.locator("#article-title")).toHaveText(seeded.title);
}

const cleanups: Array<() => void> = [];
test.afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

test.describe("newsletter reader", () => {
  test("meta line, unverified sender and confirmation banner (opened only on click)", async ({ app, page, context }) => {
    const seeded = seedNewsletter(app.user.userId, { auth: "fail", confirm: true });
    cleanups.push(seeded.cleanup);
    await openNewsletter(app, seeded);

    const meta = page.getByTestId("newsletter-meta");
    await expect(meta).toContainText("From:");
    await expect(meta).toContainText("Ferret Weekly");
    await expect(page.getByTestId("newsletter-auth-warning")).toHaveText("Sender not verified");

    const banner = page.getByTestId("newsletter-confirm-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Confirm subscription");
    const link = banner.getByTestId("newsletter-confirm-link");
    await expect(link).toHaveAttribute("href", `${FIXTURE}/newsletter/confirm/${seeded.tag}`);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");

    // Never fetched before the user's click (no prefetch, no server-side request).
    expect((await fixtureLog(seeded.tag)).confirms).toBe(0);

    const popupPromise = context.waitForEvent("page");
    await app.activate(link);
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(popup.url()).toBe(`${FIXTURE}/newsletter/confirm/${seeded.tag}`);
    // noopener: the new tab has no handle back to the app.
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    await popup.close();
    expect((await fixtureLog(seeded.tag)).confirms).toBe(1);
  });

  test("verified or unknown sender shows no warning; no banner without a confirmation link", async ({ app, page }) => {
    const seeded = seedNewsletter(app.user.userId, { auth: "none" });
    cleanups.push(seeded.cleanup);
    await openNewsletter(app, seeded);
    await expect(page.getByTestId("newsletter-meta")).toBeVisible();
    await expect(page.getByTestId("newsletter-auth-warning")).toHaveCount(0);
    await expect(page.getByTestId("newsletter-confirm-banner")).toHaveCount(0);
  });

  test("one-click unsubscribe from the reader menu, then remove the feed", async ({ app, page }) => {
    cleanups.push(allowInternalTargets());
    const seeded = seedNewsletter(app.user.userId, { oneClick: true });
    cleanups.push(seeded.cleanup);
    await openNewsletter(app, seeded);

    await app.activate(page.getByTestId("reader-more-button").filter({ visible: true }).first());
    const menu = page.getByTestId("reader-menu");
    await expect(menu).toBeVisible();
    // No web version: nothing to fetch as full text.
    await expect(menu.getByRole("menuitem", { name: "Fetch full text" })).toHaveCount(0);
    await app.activate(menu.getByRole("menuitem", { name: "Unsubscribe from newsletter…" }));

    const dialog = page.getByTestId("newsletter-unsubscribe-dialog");
    await expect(dialog).toContainText("Unsubscribe from newsletter?");
    expect((await fixtureLog(seeded.tag)).posts).toHaveLength(0);
    await app.activate(dialog.getByTestId("newsletter-unsubscribe-confirm"));

    await expect(dialog).toContainText("Unsubscribed");
    const log = await fixtureLog(seeded.tag);
    expect(log.posts).toHaveLength(1);
    expect(log.posts[0].body).toBe("List-Unsubscribe=One-Click");
    expect(log.posts[0].contentType).toBe("application/x-www-form-urlencoded");
    expect(log.posts[0].cookie).toBeNull();
    expect(log.gets).toHaveLength(0);

    await app.activate(dialog.getByTestId("newsletter-remove-feed"));
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Feed removed" })).toBeVisible();
    await expect.poll(() => feedExists(seeded.feedId)).toBe(false);
  });

  test("feed menu: envelope icon, no refresh / health, block the dedicated address", async ({ app, page }) => {
    const seeded = seedNewsletter(app.user.userId, { oneClick: false, dedicatedAddress: true });
    cleanups.push(seeded.cleanup);
    await app.open();
    await app.openSidebar();
    const line = app.isMobile
      ? app.sidebar().locator(`.ff-feeds-line[data-feed-id="${seeded.feedId}"]`)
      : app.sidebar().getByRole("button", { name: new RegExp(`^${seeded.feedName}`) }).first();
    await expect(line.locator("[data-newsletter-icon]")).toBeVisible();

    const menu = await app.openFeedMenu(seeded.feedName);
    await expect(menu.getByRole("menuitem", { name: "Refresh feed" })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Feed health" })).toHaveCount(0);
    const unsubscribe = menu.getByRole("menuitem", { name: "Unsubscribe from newsletter…" });
    await expect(unsubscribe).toBeEnabled();
    const block = menu.getByRole("menuitem", { name: "Block address…" });
    await expect(block).toBeVisible();
    await app.activate(block);

    const dialog = page.getByTestId("newsletter-block-dialog");
    await expect(dialog).toContainText("Block address?");
    await expect(dialog).toContainText("box+ff-");
    await app.activate(dialog.getByTestId("newsletter-block-confirm"));
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Address blocked" })).toBeVisible();
    await expect.poll(() => addressActive(seeded.aliasId)).toBe(false);

    // Without one-click the menu opens the sender's page on a click instead of a server request.
    const again = await app.openFeedMenu(seeded.feedName);
    await app.activate(again.getByRole("menuitem", { name: "Unsubscribe from newsletter…" }));
    const unsubDialog = page.getByTestId("newsletter-unsubscribe-dialog");
    const pageLink = unsubDialog.getByTestId("newsletter-unsubscribe-link");
    await expect(pageLink).toHaveAttribute("href", `${FIXTURE}/newsletter/unsubscribe/${seeded.tag}`);
    await expect(pageLink).toHaveAttribute("rel", "noopener noreferrer");
    await unsubDialog.getByRole("button", { name: "Cancel" }).click();
    expect((await fixtureLog(seeded.tag)).posts).toHaveLength(0);
  });
});
