import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { withExternalIds } from "../../lib/external-id-store";
import { buildZip, type TestZipEntry } from "../helpers/zip-builder";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, userId: "" , remoteOpml: "" }));
vi.mock("@/lib/db", () => ({ get db() { return state.db; }, getDatabaseProvider: () => "sqlite" }));
vi.mock("@/auth", () => ({ auth: async () => (state.userId ? { user: { id: state.userId } } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// Real SSRF rules (IP literals, localhost), but hostnames "resolve" to a public address.
vi.mock("dns/promises", () => ({ default: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } }));
vi.mock("@/lib/ssrf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ssrf")>()),
  fetchTextWithSsrfProtection: async () => state.remoteOpml,
  isTrustedFeedFetchingAllowed: async () => false,
}));
// Heavy sync-side modules are irrelevant here; keep the server-action import graph light.
vi.mock("@/lib/rss-sync", () => ({ syncUserFeeds: vi.fn(), syncFeed: vi.fn() }));

import { importOpml } from "../../app/actions/feeds";
import { POST as v1, PATCH as v1Patch } from "../../app/api/v1/[...path]/route";
import { updateFeed } from "../../app/actions/feeds";
import { POST as mcp } from "../../app/api/mcp/route";
import { POST as uploadRoute } from "../../app/api/import/freshrss/route";
import { handleFreshRssUpload } from "../../lib/import/freshrss-upload";
import { runFreshRssMigration } from "../../lib/import/freshrss-migration";
import { syncDynamicOpmlCategories } from "../../lib/dynamic-opml";
import { buildDedupeKey } from "../../lib/dedupe-key";

const fx = (name: string) => readFileSync(join(__dirname, "../fixtures/freshrss", name));
const OPML = fx("feeds_2026-11-09.opml.xml");
const STARRED = fx("starred_2026-11-09.json");
const FEED_JSON = fx("feed_2026-11-09_3_12.json");

const dir = mkdtempSync(join(tmpdir(), "feedferret-frss-"));
let counter = 0;

beforeAll(() => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], { env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url }, stdio: "pipe" });
  state.db = withExternalIds(new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) })) as unknown as PrismaClient;
}, 60_000);
afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function newUser(): Promise<string> {
  counter += 1;
  const user = await state.db.user.create({ data: { email: `frss${counter}@example.test`, name: `U${counter}`, password: "x" } });
  state.userId = user.id;
  return user.id;
}

/** Buffer is a valid fetch body at runtime; the DOM lib typing is stricter. */
const asBody = (buf: Buffer) => buf as unknown as BodyInit;

const exportZip = (extra: TestZipEntry[] = []) =>
  buildZip([
    { name: "freshrss_alice_2026-11-09_export/", data: "", method: 0 },
    { name: "feeds_2026-11-09.opml.xml", data: OPML },
    { name: "starred_2026-11-09.json", data: STARRED },
    { name: "feed_2026-11-09_3_12.json", data: FEED_JSON },
    ...extra,
  ]);

/** Order-independent, id-free snapshot of what an OPML import produced for a user. */
async function feedSnapshot(userId: string) {
  const feeds = await state.db.feed.findMany({ where: { userId }, include: { category: true }, orderBy: { url: "asc" } });
  const rules = await state.db.autoReadRule.findMany({ where: { userId }, orderBy: { name: "asc" } });
  const categories = await state.db.category.findMany({ where: { userId }, include: { parent: true }, orderBy: { name: "asc" } });
  return {
    feeds: feeds.map((f) => ({
      url: f.url, name: f.name, category: f.category?.name ?? null, sourceType: f.sourceType, htmlUrl: f.htmlUrl, description: f.description,
      priority: f.priority, unicityCriteria: f.unicityCriteria, unicityCriteriaForced: f.unicityCriteriaForced,
      scraperConfig: f.scraperConfig, httpOptions: f.httpOptions, customUserAgent: f.customUserAgent,
      fullTextSelector: f.fullTextSelector, fullTextRemoveSelectors: f.fullTextRemoveSelectors, fullTextConditions: f.fullTextConditions,
      fullTextMode: f.fullTextMode, filtersActionRead: f.filtersActionRead, updateFrequency: f.updateFrequency, autoMuted: f.autoMuted,
    })),
    rules: rules.map((r) => ({ name: r.name, query: r.query, action: r.action, scope: r.scope?.startsWith("feed:") ? "feed" : r.scope, enabled: r.enabled })),
    categories: categories.map((c) => ({ name: c.name, parent: c.parent?.name ?? null, opmlUrl: c.opmlUrl })),
  };
}

const v1Request = (path: string[], init: RequestInit & { url?: string } = {}) =>
  v1(new Request(init.url ?? `https://example.test/api/v1/${path.join("/")}`, { method: "POST", ...init }), { params: Promise.resolve({ path }) });

async function mcpImport(xml: string, dryRun = false) {
  const response = await mcp(new Request("https://example.test/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feedferret.import_opml", arguments: { xml, dryRun } } }) }));
  const body = await response.json();
  return { isError: body.result.isError === true, data: body.result.isError ? body.result.content[0].text : JSON.parse(body.result.content[0].text) };
}

describe("OPML import: every entry point maps FreshRSS exports identically", () => {
  it("UI action, REST v1, MCP, ZIP route and dynamic OPML produce the same subscriptions", async () => {
    const xml = OPML.toString("utf8");

    const viaAction = await newUser();
    const actionReport = await importOpml(xml);

    const viaRest = await newUser();
    const restRes = await v1Request(["opml"], { body: JSON.stringify({ xml }), headers: { "content-type": "application/json" } });
    expect(restRes.status).toBe(200);
    const restReport = await restRes.json();

    const viaMcp = await newUser();
    const mcpResult = await mcpImport(xml);
    expect(mcpResult.isError).toBe(false);

    const viaZip = await newUser();
    const zipRes = await uploadRoute(new Request("https://example.test/api/import/freshrss", { method: "POST", body: asBody(buildZip([{ name: "feeds.opml.xml", data: OPML }])) }));
    expect(zipRes.status).toBe(200);

    const viaV1Zip = await newUser();
    const v1ZipRes = await v1Request(["import", "freshrss"], { body: asBody(buildZip([{ name: "feeds.opml.xml", data: OPML }])) });
    expect(v1ZipRes.status).toBe(200);

    const reference = await feedSnapshot(viaAction);
    for (const [label, id] of [["rest", viaRest], ["mcp", viaMcp], ["zip", viaZip], ["v1-zip", viaV1Zip]] as const) {
      expect(await feedSnapshot(id), label).toEqual(reference);
    }

    // The three string entry points report identically (counts and issues).
    for (const report of [actionReport, restReport, mcpResult.data]) {
      expect(report).toMatchObject({ dryRun: false, feedsAdded: 11, feedsUpdated: 0, categoriesAdded: 5, rulesCreated: 1 });
      expect(report.errors).toEqual(["Broken Local: invalid or missing feed URL"]);
      expect(report.issues.some((i: { code: string }) => i.code === "unknown-extension")).toBe(true);
    }
    expect(reference.feeds).toHaveLength(11);
  });

  it("persists the semantics of the golden FreshRSS export", async () => {
    const userId = await newUser();
    await importOpml(OPML.toString("utf8"));
    const byName = async (name: string) => state.db.feed.findFirstOrThrow({ where: { userId, name }, include: { category: true } });

    const hn = await byName("Hacker News");
    expect(hn).toMatchObject({ priority: "important", updateFrequency: 30, filtersActionRead: "sponsored", autoMuted: false, category: { name: "Tech" } });
    const rule = await state.db.autoReadRule.findFirstOrThrow({ where: { userId, scope: `feed:${hn.id}` } });
    expect(rule).toMatchObject({ name: "FreshRSS filter: Hacker News", query: "intitle:hiring OR author:bot -intitle:rust", action: "mark_read", trigger: "article", enabled: true });

    const ars = await byName("Ars Technica");
    expect(ars).toMatchObject({ fullTextMode: "selector", fullTextSelector: "article .article-content", fullTextRemoveSelectors: ".ad, .related", autoMuted: true, updateFrequency: 60, unicityCriteria: "link", unicityCriteriaForced: true });

    const blog = await byName("Example Blog");
    expect(blog).toMatchObject({ sourceType: "HTML+XPath", fullTextMode: "selector", fullTextSelector: "div.post-body", customUserAgent: "Mozilla/5.0 (X11; Linux x86_64) FreshRSS" });
    expect(JSON.parse(blog.httpOptions!)).not.toHaveProperty("CURLOPT_COOKIEFILE");
    expect(JSON.parse(blog.scraperConfig!).extensions).toEqual({ futureFlag: "yes" });

    expect(await state.db.category.findFirst({ where: { userId, name: "Leer" } })).not.toBeNull();
    expect((await state.db.category.findFirstOrThrow({ where: { userId, name: "Shared Packs" } })).opmlUrl).toBe("https://packs.example.net/starter.opml");
    expect(await byName("Lone Feed")).toMatchObject({ priority: "hidden", updateFrequency: 10_080, categoryId: null });
    expect(await state.db.feed.count({ where: { userId, url: { startsWith: "file:" } } })).toBe(0);
  });

  it("is idempotent: a second import updates in place and creates nothing new", async () => {
    const userId = await newUser();
    await importOpml(OPML.toString("utf8"));
    const before = await feedSnapshot(userId);
    const again = await importOpml(OPML.toString("utf8"));
    expect(again).toMatchObject({ feedsAdded: 0, feedsUpdated: 11, categoriesAdded: 0, categoriesUpdated: 5, rulesCreated: 0, rulesUpdated: 1 });
    expect(await feedSnapshot(userId)).toEqual(before);
    expect(await state.db.autoReadRule.count({ where: { userId } })).toBe(1);
  });

  it("does not wipe local settings and never downgrades an existing full-text mode", async () => {
    const userId = await newUser();
    await state.db.feed.create({ data: { userId, url: "https://blog.example.com/archive", name: "Mine", fullTextMode: "ai", filtersActionRead: "my own keyword" } });
    await state.db.feed.create({ data: { userId, url: "https://lone.example.com/atom.xml", name: "Lone", filtersActionRead: "keep me" } });
    await importOpml(OPML.toString("utf8"));
    expect(await state.db.feed.findFirstOrThrow({ where: { userId, url: "https://blog.example.com/archive" } })).toMatchObject({ fullTextMode: "ai", name: "Example Blog" });
    // `filtersActionRead` absent from the OPML for Lone Feed → untouched.
    expect((await state.db.feed.findFirstOrThrow({ where: { userId, name: "Lone Feed" } })).filtersActionRead).toBe("keep me");
  });

  it("dry-run writes nothing and returns the same counts as the real run", async () => {
    const userId = await newUser();
    const dry = await importOpml(OPML.toString("utf8"), { dryRun: true });
    expect(await state.db.feed.count({ where: { userId } })).toBe(0);
    expect(await state.db.category.count({ where: { userId } })).toBe(0);
    expect(await state.db.autoReadRule.count({ where: { userId } })).toBe(0);
    const real = await importOpml(OPML.toString("utf8"));
    expect({ ...dry, dryRun: false }).toEqual(real);

    const mcpDry = await mcpImport(OPML.toString("utf8"), true);
    expect(mcpDry.data.dryRun).toBe(true);
    expect(mcpDry.data.feedsAdded).toBe(0);
    expect(mcpDry.data.feedsUpdated).toBe(11);
  });

  it("dynamic OPML categories use the same mapping but the remote trust policy", async () => {
    const userId = await newUser();
    const category = await state.db.category.create({ data: { userId, name: "Remote", opmlUrl: "https://packs.example.net/live.opml" } });
    state.remoteOpml = OPML.toString("utf8");
    const results = await syncDynamicOpmlCategories(userId);
    expect(results).toEqual([{ category: "Remote", success: true, count: 7 }]);

    const blog = await state.db.feed.findFirstOrThrow({ where: { userId, name: "Example Blog" } });
    const http = JSON.parse(blog.httpOptions!);
    expect(http).toMatchObject({ CURLOPT_FOLLOWLOCATION: true, CURLOPT_USERAGENT: "Mozilla/5.0 (X11; Linux x86_64) FreshRSS" });
    for (const key of ["CURLOPT_COOKIE", "CURLOPT_HTTPHEADER", "CURLOPT_PROXY", "CURLOPT_COOKIEFILE"]) expect(http).not.toHaveProperty(key);
    expect(blog).toMatchObject({ sourceType: "HTML+XPath", fullTextSelector: "div.post-body" });
    // Everything lands below the dynamic category; no rules, no nested dynamic URLs.
    const tech = await state.db.category.findFirstOrThrow({ where: { userId, name: "Tech" } });
    expect(tech.parentId).toBe(category.id);
    expect((await state.db.category.findFirstOrThrow({ where: { userId, name: "Shared Packs" } })).opmlUrl).toBeNull();
    expect(await state.db.autoReadRule.count({ where: { userId } })).toBe(0);
    expect(await state.db.category.findFirst({ where: { userId, name: "Leer" } })).not.toBeNull();

    const again = await syncDynamicOpmlCategories(userId);
    expect(again[0].success).toBe(true);
    expect(await state.db.feed.count({ where: { userId } })).toBe(11);
  });

  it("rejects XXE / billion-laughs OPML through every entry point", async () => {
    await newUser();
    const lol = `<?xml version="1.0"?><!DOCTYPE opml [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><opml><body><outline text="&b;" type="rss" xmlUrl="https://a.example/f"/></body></opml>`;
    await expect(importOpml(lol)).rejects.toThrow(/entity/i);
    const rest = await v1Request(["opml"], { body: JSON.stringify({ xml: lol }), headers: { "content-type": "application/json" } });
    expect(rest.status).toBe(400);
    expect((await mcpImport(lol)).isError).toBe(true);
    const zip = await uploadRoute(new Request("https://example.test/api/import/freshrss", { method: "POST", body: asBody(buildZip([{ name: "x.opml.xml", data: lol }])) }));
    const body = await zip.json();
    expect(body.files[0]).toMatchObject({ kind: "opml", status: "error" });
    expect(body.errors[0]).toMatch(/entity/i);
    expect(await state.db.feed.count({ where: { userId: state.userId } })).toBe(0);
  });

  it("rejects an oversized OPML (5 MB cap) for the string entry points", async () => {
    await newUser();
    await expect(importOpml("<opml>" + " ".repeat(5 * 1024 * 1024 + 1) + "</opml>")).rejects.toThrow(/too large/);
    const rest = await v1Request(["opml"], { body: JSON.stringify({ xml: "<opml>" + " ".repeat(5 * 1024 * 1024 + 1) + "</opml>" }), headers: { "content-type": "application/json" } });
    expect(rest.status).toBe(400);
  });

  it("requires authentication", async () => {
    state.userId = "";
    await expect(importOpml(OPML.toString("utf8"))).rejects.toThrow(/Unauthorized/);
    const res = await uploadRoute(new Request("https://example.test/api/import/freshrss", { method: "POST", body: asBody(OPML) }));
    expect(res.status).toBe(401);
  });
});

describe("FreshRSS ZIP export: OPML first, then article JSON", () => {
  it("imports subscriptions, orphan feeds, states, labels, bodies, dates and enclosures", async () => {
    const userId = await newUser();
    const report = await runFreshRssMigration(userId, exportZip());
    expect(report.source).toBe("zip");
    expect(report.files.map((f) => [f.name, f.kind, f.status])).toEqual([
      ["feeds_2026-11-09.opml.xml", "opml", "ok"],
      ["starred_2026-11-09.json", "articles", "ok"],
      ["feed_2026-11-09_3_12.json", "articles", "ok"],
    ]);
    expect(report.errors).toEqual([]);

    // starred(3 + 1 bad) + feed(3) — the shared article merges: 3 + 3 - 1 = 5 articles
    expect(report.articles!.counts).toMatchObject({ total: 7, created: 5, skipped: 1, orphanFeedsCreated: 2, labelsCreated: 3 });
    expect(await state.db.article.count({ where: { userId } })).toBe(5);

    const rust = await state.db.article.findFirstOrThrow({ where: { userId, externalId: "https://example.org/rust-2-0#guid" }, include: { labels: { include: { label: true } }, feed: true } });
    expect(rust).toMatchObject({ isRead: true, isStarred: true, title: "Rust 2.0 überrascht alle 🦀", author: "Ferris Krab", link: "https://example.org/rust-2-0", imageUrl: "https://example.org/img/rust.png" });
    expect(rust.feed.url).toBe("https://news.ycombinator.com/rss");
    expect(rust.feed.autoMuted).toBe(false); // subscribed via the OPML of the same run
    expect(rust.labels.map((l) => l.label.name).sort()).toEqual(["Rust", "Später lesen"]);
    expect(rust.publishedAt.toISOString()).toBe(new Date(1731135600 * 1000).toISOString());
    expect(rust.createdAt.toISOString()).toBe(new Date(1731139200123).toISOString());
    expect(JSON.parse(rust.enclosures!)).toEqual([{ href: "https://example.org/img/rust.png", type: "image/png", length: 20480 }]);
    expect(rust.content).not.toMatch(/<script|onerror/i);
    expect(rust.content).toContain("<strong>lang erwartete</strong>");
    expect(rust.extId).toMatch(/^\d+$/);
    expect(rust.dedupeKey).toBe(buildDedupeKey({ unicityCriteria: "id" }, { link: rust.link }, "https://example.org/rust-2-0#guid"));

    // A label-only article from the starred file stays unstarred and unread.
    const cake = await state.db.article.findFirstOrThrow({ where: { userId, externalId: "old-blog-apfelkuchen-2023" }, include: { labels: { include: { label: true } }, feed: true } });
    expect(cake).toMatchObject({ isStarred: false, isRead: false });
    expect(cake.labels.map((l) => l.label.name)).toEqual(["Rezepte"]);
    expect(cake.feed).toMatchObject({ url: "https://old-blog.example.net/feed.xml", name: "Old Blog (abgemeldet)", autoMuted: true });

    // No usable feedUrl → placeholder, muted, starred unread preserved.
    const gone = await state.db.article.findFirstOrThrow({ where: { userId, externalId: "gone-post-9" }, include: { feed: true } });
    expect(gone).toMatchObject({ isStarred: true, isRead: false });
    expect(gone.feed).toMatchObject({ url: "urn:freshrss:feed/42", autoMuted: true, name: "Gone Feed" });

    const podcast = await state.db.article.findFirstOrThrow({ where: { userId, externalId: "podcast-42" } });
    expect(podcast).toMatchObject({ isRead: true, kind: "audio", mediaUrl: "https://podcasts.example.com/42.mp3", mediaType: "audio/mpeg" });

    // The merged article kept starred+read although the later per-feed file said unread.
    expect(await state.db.article.count({ where: { userId, isStarred: true } })).toBe(2);
    expect(report.articles!.orphanFeeds.sort()).toEqual(["Gone Feed (urn:freshrss:feed/42)", "Old Blog (abgemeldet) (https://old-blog.example.net/feed.xml)"]);
    expect(report.issues.some((i) => i.code === "feed-url-missing")).toBe(true);
  });

  it("re-importing the same export is a no-op (no duplicates, no state regression)", async () => {
    const userId = await newUser();
    await runFreshRssMigration(userId, exportZip());
    const snapshot = async () => (await state.db.article.findMany({ where: { userId }, include: { labels: true }, orderBy: { externalId: "asc" } })).map((a) => [a.externalId, a.isRead, a.isStarred, a.labels.length, a.extId, a.content]);
    const before = await snapshot();
    const feedsBefore = await state.db.feed.count({ where: { userId } });
    const second = await runFreshRssMigration(userId, exportZip());
    expect(second.articles!.counts).toMatchObject({ created: 0, updated: 0, unchanged: 6, skipped: 1, orphanFeedsCreated: 0, labelsCreated: 0, labelAssignments: 0 });
    expect(await snapshot()).toEqual(before);
    expect(await state.db.feed.count({ where: { userId } })).toBe(feedsBefore);
    expect(await state.db.label.count({ where: { userId } })).toBe(3);
  });

  it("merges states in either file order (read/starred only ever turn on)", async () => {
    const a = await newUser();
    await runFreshRssMigration(a, exportZip());
    const b = await newUser();
    await runFreshRssMigration(b, Buffer.from(OPML));
    await runFreshRssMigration(b, Buffer.from(FEED_JSON));
    await runFreshRssMigration(b, Buffer.from(STARRED));
    const flags = async (id: string) => (await state.db.article.findMany({ where: { userId: id }, include: { labels: { include: { label: true } } }, orderBy: { externalId: "asc" } })).map((x) => [x.externalId, x.isRead, x.isStarred, x.labels.map((l) => l.label.name).sort()]);
    expect(await flags(b)).toEqual(await flags(a));
  });

  it("never regresses local state of articles that already exist", async () => {
    const userId = await newUser();
    const feed = await state.db.feed.create({ data: { userId, url: "https://news.ycombinator.com/rss", name: "HN" } });
    const existing = await state.db.article.create({ data: { userId, feedId: feed.id, title: "Local", link: "https://example.org/rust-2-0", externalId: "https://example.org/rust-2-0#guid", dedupeKey: "https://example.org/rust-2-0#guid", content: "<p>my copy</p>", publishedAt: new Date(), isRead: true, isReadLater: true } });
    const label = await state.db.label.create({ data: { userId, name: "Rust" } });
    await state.db.articleLabel.create({ data: { articleId: existing.id, labelId: label.id, userId } });

    await runFreshRssMigration(userId, Buffer.from(FEED_JSON)); // says: unread, no labels
    let row = await state.db.article.findFirstOrThrow({ where: { id: existing.id }, include: { labels: true } });
    expect(row).toMatchObject({ isRead: true, isReadLater: true, content: "<p>my copy</p>" });

    const r = await runFreshRssMigration(userId, Buffer.from(STARRED)); // adds star + second label
    row = await state.db.article.findFirstOrThrow({ where: { id: existing.id }, include: { labels: true } });
    expect(row).toMatchObject({ isRead: true, isStarred: true, content: "<p>my copy</p>" });
    expect(row.labels).toHaveLength(2);
    expect(r.articles!.counts.updated).toBe(1);
    expect(await state.db.article.count({ where: { userId, externalId: "https://example.org/rust-2-0#guid" } })).toBe(1);
  });

  it("dry-run returns the real run's counts without writing anything", async () => {
    const userId = await newUser();
    const dry = await runFreshRssMigration(userId, exportZip(), { dryRun: true });
    expect(await state.db.article.count({ where: { userId } })).toBe(0);
    expect(await state.db.feed.count({ where: { userId } })).toBe(0);
    expect(await state.db.label.count({ where: { userId } })).toBe(0);
    const real = await runFreshRssMigration(userId, exportZip());
    expect(dry.articles!.counts).toEqual(real.articles!.counts);
    expect(dry.opml).toMatchObject({ dryRun: true, feedsAdded: real.opml!.feedsAdded, categoriesAdded: real.opml!.categoriesAdded });
    expect(dry.articles!.orphanFeeds.sort()).toEqual(real.articles!.orphanFeeds.sort());
  });

  it("chunking does not change the outcome, and each chunk is transactional", async () => {
    const whole = await newUser();
    await runFreshRssMigration(whole, exportZip());
    const chunked = await newUser();
    await runFreshRssMigration(chunked, exportZip(), { chunkSize: 2 });
    const ids = async (id: string) => (await state.db.article.findMany({ where: { userId: id }, include: { labels: true }, orderBy: { externalId: "asc" } })).map((a) => [a.externalId, a.isRead, a.isStarred, a.labels.length]);
    expect(await ids(chunked)).toEqual(await ids(whole));

    // Fail the SECOND chunk's transaction after its writes ran: it must roll back, the
    // first chunk stays, and the report names the failed range.
    const failing = await newUser();
    const real = state.db.$transaction.bind(state.db) as unknown as (fn: unknown, opts?: unknown) => Promise<unknown>;
    let calls = 0;
    const spy = vi.spyOn(state.db, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
      real(async (tx: unknown) => {
        const result = await fn(tx);
        if (++calls === 2) throw new Error("boom: simulated crash");
        return result;
      }, opts)) as never);
    const report = await runFreshRssMigration(failing, Buffer.from(STARRED), { chunkSize: 2 });
    spy.mockRestore();
    expect(report.articles!.errors.some((e) => /items 3–4\): boom/.test(e))).toBe(true);
    expect(await state.db.article.count({ where: { userId: failing } })).toBe(2); // chunk 1 committed, chunk 2 rolled back
    expect(report.articles!.counts).toMatchObject({ created: 2 });

    // Resume = run again.
    const resumed = await runFreshRssMigration(failing, Buffer.from(STARRED), { chunkSize: 2 });
    expect(resumed.articles!.counts).toMatchObject({ created: 1, unchanged: 2 });
    expect(await state.db.article.count({ where: { userId: failing } })).toBe(3);
  });

  it("a later feed sync resolves to the imported rows instead of duplicating them", async () => {
    const userId = await newUser();
    await runFreshRssMigration(userId, exportZip());
    const feed = await state.db.feed.findFirstOrThrow({ where: { userId, url: "https://news.ycombinator.com/rss" } });
    const row = await state.db.article.findFirstOrThrow({ where: { userId, feedId: feed.id, externalId: "hn-item-48000001" } });
    // What the sync pipeline would compute for the same item (externalId = guid, id criteria).
    const key = buildDedupeKey(feed, { link: "https://github.com/example/feedreader", title: "x" }, "hn-item-48000001");
    expect(row.dedupeKey).toBe(key);
    expect(await state.db.article.count({ where: { userId, feedId: feed.id, dedupeKey: key } })).toBe(1);
  });

  it("only ever writes the signed-in user's rows", async () => {
    const victim = await newUser();
    const vf = await state.db.feed.create({ data: { userId: victim, url: "https://news.ycombinator.com/rss", name: "Victim HN" } });
    const va = await state.db.article.create({ data: { userId: victim, feedId: vf.id, title: "v", link: "https://example.org/rust-2-0", externalId: "https://example.org/rust-2-0#guid", dedupeKey: "https://example.org/rust-2-0#guid", content: "", publishedAt: new Date() } });
    const attacker = await newUser();
    await runFreshRssMigration(attacker, exportZip());
    expect(await state.db.article.findUniqueOrThrow({ where: { id: va.id } })).toMatchObject({ isRead: false, isStarred: false });
    expect(await state.db.feed.findUniqueOrThrow({ where: { id: vf.id } })).toMatchObject({ name: "Victim HN", priority: "main" });
    expect(await state.db.label.count({ where: { userId: victim } })).toBe(0);
    expect(await state.db.article.count({ where: { userId: victim } })).toBe(1);
    expect(await state.db.article.count({ where: { userId: attacker } })).toBe(5);
  });

  it("accepts a single OPML or article JSON file without a ZIP", async () => {
    const userId = await newUser();
    expect((await runFreshRssMigration(userId, Buffer.from(OPML))).source).toBe("opml");
    const json = await runFreshRssMigration(userId, Buffer.from(STARRED));
    expect(json.source).toBe("json");
    expect(json.articles!.counts.created).toBe(3);
  });

  it("reports progress and per-file results", async () => {
    const userId = await newUser();
    const events: string[] = [];
    const report = await runFreshRssMigration(userId, exportZip(), { chunkSize: 2, onProgress: (p) => events.push(`${p.phase}:${p.file ?? ""}:${p.done}/${p.total}`) });
    expect(events[0]).toMatch(/^read:/);
    expect(events).toContain("articles:starred_2026-11-09.json:4/4");
    expect(report.progress.some((p) => p.phase === "opml" && p.done === p.total)).toBe(true);
  });
});

describe("upload endpoint: hostile input", () => {
  const post = (body: BodyInit | Buffer, userId?: string, opts?: { maxBytes?: number; query?: string }) =>
    handleFreshRssUpload(new Request(`https://example.test/api/import/freshrss${opts?.query ?? ""}`, { method: "POST", body: body as BodyInit }), userId ?? state.userId, { maxBytes: opts?.maxBytes });

  it("rejects zip-slip archives with 400 and writes nothing", async () => {
    const userId = await newUser();
    for (const name of ["../../evil.json", "/abs/evil.json", "..\\evil.json"]) {
      const res = await post(buildZip([{ name: "feeds.opml.xml", data: OPML }, { name, data: STARRED }]));
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(/unsafe path/);
    }
    expect(await state.db.feed.count({ where: { userId } })).toBe(0);
  });

  it("rejects zip bombs, lying sizes and corrupt data", async () => {
    await newUser();
    const zeros = Buffer.alloc(70 * 1024 * 1024);
    const bomb = await post(buildZip([{ name: "starred.json", data: zeros }]));
    expect(bomb.status).toBe(400);
    expect((await bomb.json()).error.message).toMatch(/entry-too-large|ratio-exceeded/);

    const okFile = { name: "feed_ok.json", data: '{"items":[]}' };
    const liar = await post(buildZip([{ name: "starred.json", data: Buffer.alloc(2 * 1024 * 1024, 0x20), declaredSize: 50 }, okFile]));
    const liarBody = await liar.json();
    expect(liar.status).toBe(200);
    const liarFile = liarBody.files.find((f: { name: string }) => f.name === "starred.json");
    expect(liarFile).toMatchObject({ status: "error" });
    expect(liarFile.detail).toMatch(/size-mismatch/);

    const crc = await post(buildZip([{ name: "starred.json", data: STARRED, crc: 7 }, okFile]));
    expect((await crc.json()).files.find((f: { name: string }) => f.name === "starred.json").detail).toMatch(/crc-mismatch/);
  });

  it("refuses cross-site session uploads (CSRF) but accepts same-origin and header-less clients", async () => {
    const userId = await newUser();
    const send = (headers: Record<string, string>) =>
      uploadRoute(new Request("https://example.test/api/import/freshrss?dryRun=1", { method: "POST", body: asBody(OPML), headers }));
    expect((await send({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await send({ "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await send({ origin: "https://evil.example" })).status).toBe(403);
    expect((await send({ origin: "not a url" })).status).toBe(403);
    expect((await send({ "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await send({ origin: "https://example.test" })).status).toBe(200);
    expect((await send({})).status).toBe(200);
    expect(await state.db.feed.count({ where: { userId } })).toBe(0);
  });

  it("returns 400 for garbage, empty bodies and archives without importable files", async () => {
    await newUser();
    expect((await post(Buffer.from("just some text"))).status).toBe(400);
    expect((await post(buildZip([{ name: "readme.txt", data: "hi" }]))).status).toBe(400);
    expect((await post(new Uint8Array(0))).status).toBe(400);
  });

  it("caps the upload size while streaming", async () => {
    await newUser();
    const res = await post(Buffer.alloc(1024, 0x41), undefined, { maxBytes: 512 });
    expect(res.status).toBe(413);
    const declared = await handleFreshRssUpload(new Request("https://example.test/x", { method: "POST", body: "x", headers: { "content-length": "999999999" } }), state.userId);
    expect(declared.status).toBe(413);
  });

  it("reports malformed article JSON per file instead of failing the run", async () => {
    const userId = await newUser();
    const res = await post(buildZip([{ name: "feeds.opml.xml", data: OPML }, { name: "starred_bad.json", data: "{not json" }, { name: "feed_ok.json", data: '{"items": 5}' }]));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.files.filter((f: { status: string }) => f.status === "error")).toHaveLength(2);
    expect(await state.db.feed.count({ where: { userId } })).toBe(11);
  });

  it("skips non-matching archive entries but reports them", async () => {
    await newUser();
    const body = await (await post(buildZip([{ name: "__MACOSX/._feeds.opml", data: "x" }, { name: "notes.txt", data: "x" }, { name: "page.xml", data: "<html/>" }, { name: "starred.json", data: STARRED }]))).json();
    expect(body.files.filter((f: { status: string }) => f.status === "skipped").map((f: { name: string }) => f.name).sort()).toEqual(["__MACOSX/._feeds.opml", "notes.txt", "page.xml"]);
    expect(body.articles.counts.created).toBe(3);
  });

  it("rate limits the endpoint per user and allows only one import at a time", async () => {
    const userId = await newUser();
    const small = buildZip([{ name: "starred.json", data: '{"items":[]}' }]);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await post(small, userId, { query: "?dryRun=1" })).status);
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(6)).toEqual([429, 429]);

    const other = await newUser();
    const first = post(buildZip([{ name: "feeds.opml.xml", data: OPML }]), other);
    const second = await post(small, other);
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
  });
});

// ── Review hardening ─────────────────────────────────────────────────────────

const frssItem = (over: Record<string, unknown> = {}) => ({
  id: "tag:google.com,2005:reader/item/0001",
  guid: "g-1",
  crawlTimeMsec: "1577836800000", // 2020-01-01
  published: 1577836800,
  title: "Hello",
  canonical: [{ href: "https://rh.example.com/a" }],
  categories: ["user/-/state/com.google/unread"],
  origin: { streamId: "feed/1", title: "RH", feedUrl: "https://rh.example.com/feed.xml" },
  content: { content: "<p>x</p>" },
  ...over,
});
const itemsJson = (...items: unknown[]) => JSON.stringify({ id: "user/x/state/org.freshrss/starred", items });
const withFeed = async (userId: string, data: Record<string, unknown> = {}) =>
  state.db.feed.create({ data: { userId, url: "https://rh.example.com/feed.xml", name: "RH", ...data } as never });

describe("review hardening: limits, update semantics, identity", () => {
  it("caps the number of items per run and reports a clear error for the file that exceeds it", async () => {
    const userId = await newUser();
    const three = itemsJson(frssItem({ guid: "a1" }), frssItem({ guid: "a2" }), frssItem({ guid: "a3" }));
    const more = itemsJson(frssItem({ guid: "b1" }), frssItem({ guid: "b2" }));
    const report = await runFreshRssMigration(userId, buildZip([{ name: "feed_a.json", data: three }, { name: "feed_b.json", data: more }]), { maxItems: 4 });
    expect(report.files.map((f) => [f.name, f.status])).toEqual([["feed_a.json", "ok"], ["feed_b.json", "error"]]);
    expect(report.errors.join("\n")).toMatch(/Import limit reached: more than 4 articles/);
    expect(await state.db.article.count({ where: { userId } })).toBe(3);
  });

  it("an update from an OPML outline never blanks locally set name/description/priority/scraper/http options", async () => {
    const userId = await newUser();
    const feed = await withFeed(userId, { name: "Mine", description: "my notes", priority: "important", scraperConfig: '{"a":1}', httpOptions: '{"CURLOPT_COOKIE":"s=1"}' });
    const bare = '<?xml version="1.0"?><opml version="2.0"><head/><body><outline text="Mine" type="rss" xmlUrl="https://rh.example.com/feed.xml"/></body></opml>';
    await runFreshRssMigration(userId, Buffer.from(bare));
    expect(await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } })).toMatchObject({
      name: "Mine", description: "my notes", priority: "important", scraperConfig: '{"a":1}', httpOptions: '{"CURLOPT_COOKIE":"s=1"}',
    });

    const carrying = '<?xml version="1.0"?><opml version="2.0" xmlns:frss="https://freshrss.org/opml"><head/><body><outline text="Mine2" type="rss" xmlUrl="https://rh.example.com/feed.xml" description="new" frss:priority="category" frss:CURLOPT_MAXREDIRS="3"/></body></opml>';
    await runFreshRssMigration(userId, Buffer.from(carrying));
    expect(await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } })).toMatchObject({ name: "Mine2", description: "new", priority: "category" });
    expect((await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } })).httpOptions).toContain("CURLOPT_MAXREDIRS");
  });

  it("a remote (dynamic OPML) sync never touches httpOptions of an existing feed", async () => {
    const userId = await newUser();
    const feed = await withFeed(userId, { httpOptions: '{"CURLOPT_COOKIE":"s=1"}' });
    const remote = '<?xml version="1.0"?><opml version="2.0" xmlns:frss="https://freshrss.org/opml"><head/><body><outline text="RH" type="rss" xmlUrl="https://rh.example.com/feed.xml" frss:CURLOPT_MAXREDIRS="3"/></body></opml>';
    const { parseOpml } = await import("../../lib/opml");
    const { planOpmlImport, applyOpmlImportPlan } = await import("../../lib/import/opml-import");
    await applyOpmlImportPlan(userId, planOpmlImport(await parseOpml(remote), { trust: "remote" }));
    expect((await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } })).httpOptions).toBe('{"CURLOPT_COOKIE":"s=1"}');
  });

  it("two guids sharing one link stay two articles; a guid-less item still merges into a row that never had an external id", async () => {
    const userId = await newUser();
    const feed = await withFeed(userId);
    const report = await runFreshRssMigration(userId, Buffer.from(itemsJson(frssItem({ guid: "g-A" }), frssItem({ guid: "g-B" }))));
    expect(report.articles!.counts.created).toBe(2);
    expect(await state.db.article.count({ where: { feedId: feed.id } })).toBe(2);

    // A row without external id (older sync) for a different link; a guid-less item with that link merges.
    const legacy = await state.db.article.create({ data: { userId, feedId: feed.id, title: "Legacy", link: "https://rh.example.com/legacy", dedupeKey: "legacy-key", contentHash: "h", content: "", excerpt: "", publishedAt: new Date(1577836800000) } as never });
    const merged = await runFreshRssMigration(userId, Buffer.from(itemsJson(frssItem({ guid: undefined, id: undefined, canonical: [{ href: "https://rh.example.com/legacy" }], categories: ["user/-/state/com.google/starred"] }))));
    expect(merged.articles!.counts).toMatchObject({ created: 0, updated: 1 });
    expect((await state.db.article.findUniqueOrThrow({ where: { id: legacy.id } })).isStarred).toBe(true);
  });

  it("several items resolving to one existing article produce one update and no duplicate label links", async () => {
    const userId = await newUser();
    const feed = await withFeed(userId, { unicityCriteria: "link" });
    const existing = await state.db.article.create({ data: { userId, feedId: feed.id, title: "E", link: "https://rh.example.com/a", externalId: "G", dedupeKey: buildDedupeKey({ unicityCriteria: "link" }, { link: "https://rh.example.com/a" }, "G"), contentHash: "h", content: "", excerpt: "", publishedAt: new Date(1577836800000) } as never });
    const labelled = ["user/-/label/X", "user/-/state/com.google/read"];
    const report = await runFreshRssMigration(userId, Buffer.from(itemsJson(
      frssItem({ guid: "G", canonical: [{ href: "https://rh.example.com/a" }], categories: labelled }),
      frssItem({ guid: "G", canonical: [{ href: "https://rh.example.com/other" }], categories: labelled }),
    )));
    expect(report.errors).toEqual([]);
    expect(report.articles!.counts).toMatchObject({ created: 0, updated: 1, labelAssignments: 1 });
    expect(await state.db.articleLabel.count({ where: { articleId: existing.id } })).toBe(1);
  });

  it("hashes over-long guids and truncates titles", async () => {
    const userId = await newUser();
    await withFeed(userId);
    const report = await runFreshRssMigration(userId, Buffer.from(itemsJson(frssItem({ guid: "g".repeat(5000), title: "T".repeat(5000) }))));
    expect(report.errors).toEqual([]);
    const row = await state.db.article.findFirstOrThrow({ where: { userId } });
    expect(row.externalId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.title.length).toBe(1000);
    expect(row.dedupeKey!.length).toBeLessThan(200);
  });

  it("stamps imported UNREAD items with the import time but keeps crawl time for read/starred ones", async () => {
    const userId = await newUser();
    await withFeed(userId);
    const before = Date.now() - 1000;
    await runFreshRssMigration(userId, Buffer.from(itemsJson(
      frssItem({ guid: "u1" }),
      frssItem({ guid: "r1", categories: ["user/-/state/com.google/read"] }),
      frssItem({ guid: "s1", categories: ["user/-/state/com.google/unread", "user/-/state/com.google/starred"] }),
    )));
    const at = async (externalId: string) => (await state.db.article.findFirstOrThrow({ where: { userId, externalId } })).createdAt.getTime();
    expect(await at("u1")).toBeGreaterThan(before);
    expect(await at("r1")).toBe(1577836800000);
    expect(await at("s1")).toBe(1577836800000);
  });
});

describe("per-feed proxy is validated against SSRF rules at save time", () => {
  const unsafe = JSON.stringify({ CURLOPT_PROXY: "http://169.254.169.254:80" });
  const safe = JSON.stringify({ CURLOPT_PROXY: "http://proxy.example.net:3128", CURLOPT_MAXREDIRS: 3 });
  const patch = (feedId: string, body: unknown) =>
    v1Patch(new Request(`https://example.test/api/v1/feeds/${feedId}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ path: ["feeds", feedId] }) });

  it("REST v1 PATCH rejects loopback/link-local/private/non-http proxies and accepts a public one", async () => {
    const userId = await newUser();
    const feed = await withFeed(userId);
    for (const proxy of ["http://169.254.169.254", "http://127.0.0.1:8080", "http://localhost:3128", "http://10.0.0.5:3128", "http://[::1]:3128", "socks5://proxy.example.net:1080", "proxy.example.net:3128"]) {
      const res = await patch(feed.id, { httpOptions: JSON.stringify({ CURLOPT_PROXY: proxy }) });
      expect(res.status, proxy).toBe(422);
      expect((await res.json()).error.message, proxy).toMatch(/Proxy/);
    }
    expect((await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } })).httpOptions).toBeNull();
    expect((await patch(feed.id, { httpOptions: safe })).status).toBe(200);
    expect((await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } })).httpOptions).toBe(safe);
  });

  it("the UI server action rejects an internal proxy and keeps the stored options", async () => {
    const userId = await newUser();
    const feed = await withFeed(userId, { httpOptions: safe });
    await expect(updateFeed(feed.id, { httpOptions: unsafe })).rejects.toThrow(/Proxy URL points to a private IP/);
    expect((await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } })).httpOptions).toBe(safe);
    await updateFeed(feed.id, { httpOptions: null });
    await updateFeed(feed.id, { name: "renamed" });
  });

  it("MCP update_feed cannot set httpOptions at all", async () => {
    const userId = await newUser();
    const feed = await withFeed(userId);
    const res = await mcp(new Request("https://example.test/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feedferret.update_feed", arguments: { feedId: feed.id, httpOptions: unsafe } } }) }));
    await res.json();
    expect((await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } })).httpOptions).toBeNull();
  });

  it("OPML import drops an unsafe proxy (reported) but imports the feed and its other options", async () => {
    const userId = await newUser();
    const xml = (proxy: string) => `<?xml version="1.0"?><opml version="2.0" xmlns:frss="https://freshrss.org/opml"><head/><body><outline text="P" type="rss" xmlUrl="https://rh.example.com/p.xml" frss:CURLOPT_PROXY="${proxy}" frss:CURLOPT_MAXREDIRS="3"/><outline text="Q" type="rss" xmlUrl="https://rh.example.com/q.xml" frss:CURLOPT_PROXY="http://proxy.example.net:3128"/></body></opml>`;
    const dry = await runFreshRssMigration(userId, Buffer.from(xml("http://127.0.0.1:3128")), { dryRun: true });
    expect(dry.issues.some((i) => i.code === "proxy-blocked" && i.subject === "P")).toBe(true);
    const report = await runFreshRssMigration(userId, Buffer.from(xml("http://127.0.0.1:3128")));
    expect(report.issues.filter((i) => i.code === "proxy-blocked").map((i) => i.subject)).toEqual(["P"]);
    expect(JSON.parse((await state.db.feed.findFirstOrThrow({ where: { userId, url: "https://rh.example.com/p.xml" } })).httpOptions!)).toEqual({ CURLOPT_MAXREDIRS: 3 });
    expect(JSON.parse((await state.db.feed.findFirstOrThrow({ where: { userId, url: "https://rh.example.com/q.xml" } })).httpOptions!)).toMatchObject({ CURLOPT_PROXY: "http://proxy.example.net:3128" });
  });

  it("OPML import gives curl-style bare host:port proxies a scheme and reports SOCKS", async () => {
    const userId = await newUser();
    const xml = `<?xml version="1.0"?><opml version="2.0" xmlns:frss="https://freshrss.org/opml"><head/><body><outline text="H" type="rss" xmlUrl="https://rh.example.com/h.xml" frss:CURLOPT_PROXY="proxy.example.net:3128"/><outline text="S" type="rss" xmlUrl="https://rh.example.com/s.xml" frss:CURLOPT_PROXY="proxy.example.net:1080" frss:CURLOPT_PROXYTYPE="5"/></body></opml>`;
    const report = await runFreshRssMigration(userId, Buffer.from(xml));
    expect(report.issues.some((i) => i.code === "proxy-blocked")).toBe(false);
    expect(report.issues.filter((i) => i.code === "proxy-socks").map((i) => i.subject)).toEqual(["S"]);
    const h = await state.db.feed.findFirstOrThrow({ where: { userId, url: "https://rh.example.com/h.xml" } });
    expect(JSON.parse(h.httpOptions!)).toMatchObject({ CURLOPT_PROXY: "http://proxy.example.net:3128" });
    const sFeed = await state.db.feed.findFirstOrThrow({ where: { userId, url: "https://rh.example.com/s.xml" } });
    expect(sFeed.httpOptions ? JSON.parse(sFeed.httpOptions).CURLOPT_PROXY : undefined).toBeUndefined();
  });
});
