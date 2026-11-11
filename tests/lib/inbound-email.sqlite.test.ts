// N1 PR A: newsletter ingest against a real SQLite DB (with the extId
// extension), driven by fixture EMLs. Also checks that an ingested newsletter
// is an ordinary item for the Fever and GReader APIs. No network.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({ dir: "", url: "" }));
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  const { withExternalIds } = await import("@/lib/external-id-store");
  fixture.dir = mkdtempSync(join(tmpdir(), "inbound-email-"));
  fixture.url = `file:${join(fixture.dir, "test.db")}`;
  return { db: withExternalIds(new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: fixture.url }) })), getDatabaseProvider: () => "sqlite" };
});
vi.mock("@/lib/rate-limit", () => ({
  peekRateLimit: () => ({ success: true }),
  checkRateLimit: () => ({ success: true }),
  getClientIdentifier: () => "u",
  RATE_LIMITS: { fever: {}, greader: {} },
}));
vi.mock("@/lib/greader", async (original) => ({
  ...(await original<typeof import("@/lib/greader")>()),
  authenticateGReaderRequest: vi.fn(async () => ({ id: "u", email: "u@example.org" })),
}));
vi.mock("@/lib/feed-fetcher", async (original) => ({
  ...(await original<typeof import("@/lib/feed-fetcher")>()),
  fetchFeedArticles: vi.fn(async () => {
    throw new Error("newsletter feeds must never be fetched");
  }),
}));

import { db } from "@/lib/db";
import { ingestRawEmail, NEWSLETTER_SOURCE_TYPE } from "@/lib/inbound-email";
import { syncFeed } from "@/lib/rss-sync";
import { hashApiToken } from "@/lib/token";
import { POST as feverPOST } from "@/app/api/fever/route";
import { GET as greaderGET } from "@/app/api/greader/[...path]/route";
import { fetchFeedArticles } from "@/lib/feed-fetcher";

const TOKEN = "a".repeat(26);
const OTHER_TOKEN = "b".repeat(26);
const eml = (name: string) => readFileSync(join(__dirname, "..", "fixtures", "emails", name));
const RECIPIENT = `inbox+ff-${TOKEN}@example.org`;

beforeAll(async () => {
  execFileSync("node_modules/.bin/prisma", ["db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: fixture.url },
    stdio: "pipe",
  });
  await db.user.create({ data: { id: "u", email: "u@test.org" } });
  await db.user.create({ data: { id: "v", email: "v@test.org" } });
  await db.apiToken.create({ data: { userId: "u", name: "test", tokenHash: "hash", feverKey: hashApiToken("key"), scope: "write" } });
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
  rmSync(fixture.dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.article.deleteMany({});
  await db.newsletterAddress.deleteMany({});
  await db.feed.deleteMany({});
  await db.category.deleteMany({});
  await db.newsletterAddress.create({ data: { userId: "u", token: TOKEN } });
});

describe("ingestRawEmail routing", () => {
  it("routes the plus-address form and auto-creates a sender feed in the Newsletter folder", async () => {
    const result = await ingestRawEmail(eml("substack-confirmation.eml"), { recipients: [RECIPIENT] });
    expect(result).toMatchObject({ status: "created", userId: "u", messageId: "confirm-123@substack.com" });
    const feed = await db.feed.findUniqueOrThrow({ where: { id: result.feedId }, include: { category: true } });
    expect(feed).toMatchObject({
      sourceType: NEWSLETTER_SOURCE_TYPE,
      // substack.com is shared by many newsletters: grouped by full address.
      url: "newsletter:from:pragmaticnotes@substack.com",
      newsletterSender: "from:pragmaticnotes@substack.com",
      name: "Pragmatic Notes",
    });
    expect(feed.category?.name).toBe("Newsletter");
    expect(feed.extId).toBeTruthy();
    const address = await db.newsletterAddress.findUniqueOrThrow({ where: { token: TOKEN } });
    expect(address.lastReceivedAt).toBeInstanceOf(Date);
  });

  it("routes the <token>@domain form and groups by List-Id", async () => {
    const result = await ingestRawEmail(eml("beehiiv-tracking-pixels.eml"), { recipients: [`Reader <${TOKEN.toUpperCase()}@nl.example.org>`] });
    expect(result.status).toBe("created");
    const feed = await db.feed.findUniqueOrThrow({ where: { id: result.feedId } });
    expect(feed.url).toBe("newsletter:list:weeklybyte.beehiiv.com");
    expect(feed.name).toBe("The Weekly Byte");
  });

  it("falls back to header recipients and groups by sender domain", async () => {
    const result = await ingestRawEmail(eml("rfc8058-one-click-unsubscribe.eml"), { recipients: [] });
    expect(result.status).toBe("created");
    const feed = await db.feed.findUniqueOrThrow({ where: { id: result.feedId } });
    expect(feed.url).toBe("newsletter:domain:digest.example.com");
    expect(feed.htmlUrl).toBe("https://digest.example.com");
  });

  it("reuses one Newsletter folder and one feed per sender", async () => {
    const a = await ingestRawEmail(eml("rfc8058-one-click-unsubscribe.eml"), { recipients: [RECIPIENT] });
    const raw = eml("rfc8058-one-click-unsubscribe.eml").toString().replace("digest-2026-11-11@", "digest-2026-11-12@");
    const b = await ingestRawEmail(raw, { recipients: [RECIPIENT] });
    await ingestRawEmail(eml("substack-confirmation.eml"), { recipients: [RECIPIENT] });
    expect(b.status).toBe("created");
    expect(b.feedId).toBe(a.feedId);
    expect(await db.category.count({ where: { userId: "u", name: "Newsletter" } })).toBe(1);
    expect(await db.feed.count({ where: { userId: "u" } })).toBe(2);
  });

  it("uses the address's fixed feed and leaves that feed's sync bookkeeping alone", async () => {
    const web = await db.feed.create({ data: { userId: "u", url: "https://blog.example/feed", name: "Blog", lastFetchedAt: new Date(0) } });
    await db.newsletterAddress.update({ where: { token: TOKEN }, data: { feedId: web.id } });
    const result = await ingestRawEmail(eml("substack-confirmation.eml"), { recipients: [RECIPIENT] });
    expect(result).toMatchObject({ status: "created", feedId: web.id });
    expect((await db.feed.findUniqueOrThrow({ where: { id: web.id } })).lastFetchedAt).toEqual(new Date(0));
  });

  it("drops unknown, inactive and missing tokens without creating anything", async () => {
    expect((await ingestRawEmail(eml("unknown-token.eml"), { recipients: [] })).status).toBe("unknown-token");
    expect((await ingestRawEmail(eml("unknown-token.eml"), { recipients: ["someone@example.org"] })).status).toBe("unknown-token");
    expect((await ingestRawEmail("Subject: x\r\n\r\nbody", { recipients: ["plain@example.org"] })).status).toBe("no-token");
    await db.newsletterAddress.create({ data: { userId: "v", token: OTHER_TOKEN, isActive: false } });
    expect((await ingestRawEmail(eml("unknown-token.eml"), { recipients: [`${OTHER_TOKEN}@nl.example.org`] })).status).toBe("inactive");
    expect(await db.article.count()).toBe(0);
    expect(await db.feed.count()).toBe(0);
  });

  it("rejects oversized mails before parsing", async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    expect((await ingestRawEmail(huge, { recipients: [RECIPIENT] })).status).toBe("too-large");
  });
});

describe("dedupe", () => {
  it("dedupes by Message-ID and never rewrites the existing row (updatedAt stays)", async () => {
    const first = await ingestRawEmail(eml("beehiiv-tracking-pixels.eml"), { recipients: [RECIPIENT] });
    const before = await db.article.findUniqueOrThrow({ where: { id: first.articleId } });
    await new Promise((r) => setTimeout(r, 15));
    const changed = eml("beehiiv-tracking-pixels.eml").toString().replace("Rust in the kernel", "Different subject");
    const second = await ingestRawEmail(changed, { recipients: [RECIPIENT] });
    expect(second).toMatchObject({ status: "duplicate", articleId: first.articleId });
    const after = await db.article.findUniqueOrThrow({ where: { id: first.articleId } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.title).toBe(before.title);
    expect(before.dedupeKey).toBe("email:issue42.beehiiv@mail.weeklybyte.io");
    expect(await db.article.count()).toBe(1);
  });

  it("falls back to a content hash key when Message-ID is missing", async () => {
    const raw = eml("rfc8058-one-click-unsubscribe.eml").toString().replace(/^Message-ID:.*\n/m, "");
    const a = await ingestRawEmail(raw, { recipients: [RECIPIENT] });
    const b = await ingestRawEmail(raw, { recipients: [RECIPIENT] });
    expect(a.status).toBe("created");
    expect(b.status).toBe("duplicate");
    const row = await db.article.findUniqueOrThrow({ where: { id: a.articleId } });
    expect(row.dedupeKey).toMatch(/^email:sha256:[0-9a-f]{64}$/);
  });
});

describe("content hygiene", () => {
  it("detects the double-opt-in link without following it", async () => {
    const result = await ingestRawEmail(eml("substack-confirmation.eml"), { recipients: [RECIPIENT] });
    const row = await db.article.findUniqueOrThrow({ where: { id: result.articleId } });
    expect(row.confirmationUrl).toBe("https://pragmaticnotes.substack.com/subscribe/confirm?token=xyz123&email=reader%40example.org");
    expect(row.title).toBe("Confirm your subscription to Pragmatic Notes");
    expect(row.emailSender).toBe("pragmaticnotes@substack.com");
    expect(row.content).not.toContain("<style");
    expect(fetchFeedArticles).not.toHaveBeenCalled();
  });

  it("does not flag regular issues as confirmations", async () => {
    const result = await ingestRawEmail(eml("beehiiv-tracking-pixels.eml"), { recipients: [RECIPIENT] });
    expect((await db.article.findUniqueOrThrow({ where: { id: result.articleId } })).confirmationUrl).toBeNull();
  });

  it("strips tracking pixels, hidden preheaders and tracking params", async () => {
    const result = await ingestRawEmail(eml("beehiiv-tracking-pixels.eml"), { recipients: [RECIPIENT] });
    const row = await db.article.findUniqueOrThrow({ where: { id: result.articleId } });
    expect(row.content).toContain("https://media.beehiiv.com/uploads/hero.png");
    expect(row.content).not.toContain("open.gif");
    expect(row.content).not.toContain("tracker.example.net");
    expect(row.content).not.toContain("eotrx.substackcdn.com");
    expect(row.content).not.toContain("Preheader junk");
    expect(row.content).not.toMatch(/utm_|mc_cid|mc_eid|_bhlid/);
    expect(row.content).toContain("https://example.com/article?id=7");
    // "View in browser" becomes the article link (tracking params removed).
    expect(row.link).toBe("https://weeklybyte.io/p/issue-42?keep=1");
    expect(row.contentHash).toBeTruthy();
    expect(row.excerpt).toContain("Rust in the kernel");
  });

  it("parses RFC 2369 / RFC 8058 unsubscribe headers and renders plain-text mails", async () => {
    const result = await ingestRawEmail(eml("rfc8058-one-click-unsubscribe.eml"), { recipients: [RECIPIENT] });
    const row = await db.article.findUniqueOrThrow({ where: { id: result.articleId } });
    expect(row).toMatchObject({
      listUnsubscribeUrl: "https://digest.example.com/unsubscribe/opaque-token-1",
      listUnsubscribeMailto: "mailto:unsubscribe@digest.example.com?subject=unsubscribe",
      listUnsubscribeOneClick: true,
      author: "Morning Digest",
    });
    expect(row.content).toContain('<a href="https://digest.example.com/story/1">');
    expect(row.content).toContain("<p>Good morning!</p>");
    // No "view online" link: synthetic, stable per message.
    expect(row.link).toBe(`newsletter:domain:digest.example.com#${encodeURIComponent("email:digest-2026-11-11@digest.example.com")}`);
    expect(row.contentHash).toBeNull();
  });

  it("sanitizes XSS, SVG, forms, frames and layout-busting styles", async () => {
    const result = await ingestRawEmail(eml("malicious-xss-svg.eml"), { recipients: [RECIPIENT] });
    const html = (await db.article.findUniqueOrThrow({ where: { id: result.articleId } })).content;
    expect(html).toContain("Safe text stays.");
    for (const bad of ["<script", "onload", "onerror", "javascript:", "<svg", "<iframe", "<form", "<input", "<button", "<base", "<meta", "<style", "<math", "data:image/svg", "position:fixed", "position: fixed", "9999px", "alert("]) {
      expect(html.toLowerCase()).not.toContain(bad);
    }
  });

  it("drops attachments and inlines only small raster cid images", async () => {
    const result = await ingestRawEmail(eml("multipart-attachment.eml"), { recipients: [RECIPIENT] });
    const html = (await db.article.findUniqueOrThrow({ where: { id: result.articleId } })).content;
    expect(html).toMatch(/<img[^>]+src="data:image\/png;base64,iVBORw0KGgo/);
    expect(html).not.toContain("cid:");
    expect(html).not.toContain("Missing");
    expect(html).not.toMatch(/catalogue\.pdf|setup\.exe|JVBERi|application\/pdf/);
  });
});

describe("sync and client APIs", () => {
  it("never fetches newsletter feeds over HTTP", async () => {
    const result = await ingestRawEmail(eml("rfc8058-one-click-unsubscribe.eml"), { recipients: [RECIPIENT] });
    expect(await syncFeed("u", result.feedId!)).toMatchObject({ success: true, count: 0 });
    expect(fetchFeedArticles).not.toHaveBeenCalled();
    const feed = await db.feed.findUniqueOrThrow({ where: { id: result.feedId } });
    expect(feed.autoMuted).toBe(false);
    expect(feed.consecutiveFailureCount).toBe(0);
  });

  it("serves newsletter items through Fever and GReader like any feed item", async () => {
    const result = await ingestRawEmail(eml("beehiiv-tracking-pixels.eml"), { recipients: [RECIPIENT] });
    const row = await db.article.findUniqueOrThrow({ where: { id: result.articleId } });
    expect(row.extId).toBeTruthy();

    const body = new URLSearchParams({ api: "", api_key: "key", items: "", feeds: "", groups: "" });
    const fever = await (await feverPOST(new Request("http://localhost/api/fever", { method: "POST", body }))).json();
    const item = fever.items.find((i: { id: number }) => String(i.id) === BigInt(row.extId!).toString());
    expect(item).toMatchObject({ title: "Issue #42: Rust in the kernel", url: "https://weeklybyte.io/p/issue-42?keep=1", is_read: 0 });
    expect(fever.feeds.some((f: { title: string }) => f.title === "The Weekly Byte")).toBe(true);
    expect(fever.groups.some((g: { title: string }) => g.title === "Newsletter")).toBe(true);

    const path = ["reader", "api", "0", "stream", "contents", "user", "-", "state", "com.google", "reading-list"];
    const res = await greaderGET(new Request(`http://localhost/api/greader/${path.join("/")}?output=json`), { params: Promise.resolve({ path }) });
    expect(res.status).toBe(200);
    const stream = await res.json();
    const entry = stream.items.find((i: { title: string }) => i.title === "Issue #42: Rust in the kernel");
    expect(entry).toBeTruthy();
    expect(entry.origin.title).toBe("The Weekly Byte");
    expect(entry.categories).toContain("user/-/label/Newsletter");
    expect(entry.summary.content).toContain("Rust in the kernel");
  });
});
