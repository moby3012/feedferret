// Security wave 3 review follow-ups (PR #245): connector routes refused at
// create time, secrets kept out of stored article links / feed errors, the
// synthetic-link rewrite keeps Article.updatedAt, FreshRSS import, and the
// email-change normalization / duplicate / notification flow.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  session: null as null | { user: { id: string }; authenticatedAt?: number },
  fetchFeed: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
  mailEnabled: false,
  notices: [] as Array<{ oldEmail: string; newEmail: string }>,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => state.session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/feed-fetcher", async (importOriginal) => {
  state.fetchFeed = vi.fn();
  return { ...(await importOriginal<typeof import("../../lib/feed-fetcher")>()), fetchFeedArticles: state.fetchFeed };
});
vi.mock("@/lib/mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/mail")>()),
  isMailServiceEnabled: async () => state.mailEnabled,
  sendEmailChangeNotices: async (args: { oldEmail: string; newEmail: string }) => {
    state.notices.push({ oldEmail: args.oldEmail, newEmail: args.newEmail });
    return true;
  },
}));

import { addFeed } from "../../app/actions/feeds";
import { updateProfile } from "../../app/actions/settings";
import { importOpmlXml } from "../../lib/import/opml-import";
import { importFreshRssArticles } from "../../lib/import/freshrss-json";
import { syncFeed, upsertArticleBatch } from "../../lib/rss-sync";
import { resetConnectorSecretRulesCache } from "../../lib/connector-secrets";

const KEY = "S3CRET-rsshub-key";
const dir = mkdtempSync(join(tmpdir(), "feedferret-wave3-review-"));
const ids = { alice: "", bob: "" };

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  ids.alice = (await state.db.user.create({ data: { email: "alice@test", name: "Alice", password: await bcrypt.hash("correct horse", 4) } })).id;
  ids.bob = (await state.db.user.create({ data: { email: "bob@test", name: "Bob" } })).id;
  process.env.FEEDFERRET_RSSHUB_URL = "https://rsshub.test";
  process.env.FEEDFERRET_RSSHUB_KEY = KEY;
}, 120_000);

afterAll(async () => {
  delete process.env.FEEDFERRET_RSSHUB_URL;
  delete process.env.FEEDFERRET_RSSHUB_KEY;
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetConnectorSecretRulesCache();
  state.session = { user: { id: ids.alice } };
  state.fetchFeed.mockReset();
  state.mailEnabled = false;
  state.notices = [];
});

describe("N3 review: connector routes refused at create time", () => {
  it("addFeed refuses RSSHub built-in / transform routes (incl. encoded) without fetching", async () => {
    for (const url of [
      "https://rsshub.test/rsshub/transform/html/http%3A%2F%2Fpostgres%3A5432%2F/item=a",
      "https://rsshub.test/%72sshub/transform/html/x/y",
      "https://rsshub.test/api/routes",
    ]) {
      expect(await addFeed(url), url).toMatchObject({ success: false });
    }
    expect(state.fetchFeed).not.toHaveBeenCalled();
    expect(await state.db.feed.count({ where: { userId: ids.alice } })).toBe(0);
  });

  it("OPML import skips refused connector routes and stores allowed ones without the key", async () => {
    const xml = `<?xml version="1.0"?><opml version="2.0"><head><title>t</title></head><body>
      <outline type="rss" text="Transform" xmlUrl="https://rsshub.test/rsshub/transform/html/x/y"/>
      <outline type="rss" text="YT" xmlUrl="https://rsshub.test/youtube/channel/opml?key=${KEY}"/>
    </body></opml>`;
    const report = await importOpmlXml(ids.alice, xml);
    expect(report.issues.some((issue) => issue.code === "connector-route-blocked" && issue.subject === "Transform")).toBe(true);
    const urls = (await state.db.feed.findMany({ where: { userId: ids.alice }, select: { url: true } })).map((f) => f.url);
    expect(urls).toEqual(["https://rsshub.test/youtube/channel/opml"]);
  });

  it("FreshRSS article import never stores a key or a refused connector route", async () => {
    const item = (feedUrl: string, id: string) => ({
      id: `tag:google.com,2005:reader/item/${id}`,
      title: `Item ${id}`,
      alternate: [{ href: `https://example.com/${id}` }],
      published: 1_700_000_000,
      origin: { streamId: `feed/${id}`, feedUrl, title: `Feed ${id}` },
    });
    await importFreshRssArticles(ids.alice, [
      item(`https://rsshub.test/youtube/channel/opml?key=${KEY}`, "1"),
      item("https://rsshub.test/rsshub/transform/html/x/y", "2"),
    ]);
    const feeds = await state.db.feed.findMany({ where: { userId: ids.alice }, select: { url: true, autoMuted: true } });
    expect(JSON.stringify(feeds)).not.toContain(KEY);
    expect(feeds.some((f) => f.url.includes("/rsshub/transform"))).toBe(false);
    expect(feeds.find((f) => f.url.startsWith("urn:freshrss:blocked-connector-route:"))?.autoMuted).toBe(true);
    // The keyed origin URL resolved to the existing keyless subscription.
    expect(feeds.filter((f) => f.url === "https://rsshub.test/youtube/channel/opml").length).toBe(1);
  });
});

describe("N3 review: secrets stay out of stored article links and feed errors", () => {
  it("a legacy keyed feed stores keyless synthetic links and a redacted lastError", async () => {
    const feed = await state.db.feed.create({ data: { userId: ids.alice, name: "Legacy", url: `https://rsshub.test/github/repo/a/b?key=${KEY}` } });
    state.fetchFeed.mockResolvedValueOnce({ title: "Legacy", articles: [{ title: "No link", link: "", content: "<p>body</p>", externalId: "ext-1" }] });
    const ok = await syncFeed(ids.alice, feed.id);
    expect(ok.success).toBe(true);
    const article = await state.db.article.findFirstOrThrow({ where: { feedId: feed.id } });
    expect(article.link.startsWith("https://rsshub.test/github/repo/a/b#")).toBe(true);
    expect(article.link).not.toContain(KEY);

    state.fetchFeed.mockRejectedValueOnce(new Error(`Fetch failed: 500 for https://rsshub.test/github/repo/a/b?key=${KEY}`));
    const failed = await syncFeed(ids.alice, feed.id);
    expect(JSON.stringify(failed)).not.toContain(KEY);
    const row = await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } });
    expect(row.lastError).toContain("***");
    expect(row.lastError).not.toContain(KEY);
  });

  it("rewriting only a synthetic link keeps Article.updatedAt", async () => {
    const feed = await state.db.feed.create({ data: { userId: ids.alice, name: "Synthetic", url: "https://rsshub.test/x/y" } });
    const publishedAt = new Date("2026-01-01T00:00:00Z");
    const base = {
      feedId: feed.id, userId: ids.alice, title: "T", externalId: null, dedupeKey: "d1", contentHash: null,
      content: "c", excerpt: "c", author: null, publishedAt, imageUrl: null, enclosures: null,
    };
    const created = await state.db.article.create({ data: { ...base, link: `https://rsshub.test/x/y?key=${KEY}#d1` } });
    const before = (await state.db.article.findUniqueOrThrow({ where: { id: created.id } })).updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await upsertArticleBatch([{ ...base, link: "https://rsshub.test/x/y#d1", linkSynthetic: true }]);
    const after = await state.db.article.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.link).toBe("https://rsshub.test/x/y#d1");
    expect(after.updatedAt.getTime()).toBe(before.getTime());

    // A real content change still bumps it.
    await upsertArticleBatch([{ ...base, title: "T2", link: "https://rsshub.test/x/y#d1", linkSynthetic: true }]);
    expect((await state.db.article.findUniqueOrThrow({ where: { id: created.id } })).updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe("email change review: normalization, duplicates, notices", () => {
  it("stores the trimmed lower-case address and notifies old + new when mail is configured", async () => {
    state.mailEnabled = true;
    const result = await updateProfile({ email: "  Alice.New@Test.COM ", currentPassword: "correct horse" });
    expect(result).toMatchObject({ success: true, emailChanged: true, emailNotice: "sent" });
    expect((await state.db.user.findUniqueOrThrow({ where: { id: ids.alice } })).email).toBe("alice.new@test.com");
    expect(state.notices).toEqual([{ oldEmail: "alice@test", newEmail: "alice.new@test.com" }]);
  });

  it("reports a taken address as emailTaken (any case), not a server error", async () => {
    expect(await updateProfile({ email: "BOB@test", currentPassword: "correct horse" })).toEqual({ success: false, code: "emailTaken" });
    expect((await state.db.user.findUniqueOrThrow({ where: { id: ids.alice } })).email).toBe("alice.new@test.com");
  });

  it("treats a legacy mixed-case address of another user as taken (case-insensitive lookup)", async () => {
    await state.db.user.create({ data: { email: "Carol@Legacy.Test", name: "Carol" } });
    expect(await updateProfile({ email: "carol@legacy.test", currentPassword: "correct horse" })).toEqual({ success: false, code: "emailTaken" });
    expect((await state.db.user.findUniqueOrThrow({ where: { id: ids.alice } })).email).toBe("alice.new@test.com");
  });

  it("flags that no notice was sent when mail delivery is not configured", async () => {
    const result = await updateProfile({ email: "alice3@test", currentPassword: "correct horse" });
    expect(result).toMatchObject({ success: true, emailChanged: true, emailNotice: "unavailable" });
    expect(state.notices).toEqual([]);
  });
});
