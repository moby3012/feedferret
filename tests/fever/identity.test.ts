import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({ dir: "", url: "" }));
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  const { withExternalIds } = await import("@/lib/external-id-store");
  fixture.dir = mkdtempSync(join(tmpdir(), "numeric-api-"));
  fixture.url = `file:${join(fixture.dir, "test.db")}`;
  const raw = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: fixture.url }) });
  return { db: withExternalIds(raw) };
});
vi.mock("@/lib/rate-limit", () => ({ peekRateLimit: () => ({ success: true }), checkRateLimit: () => ({ success: true }), getClientIdentifier: () => "u", RATE_LIMITS: { fever: {} } }));
import { hashApiToken } from "@/lib/token";
import { db } from "@/lib/db";
import { POST } from "@/app/api/fever/route";
import { backfillExternalIds } from "@/lib/external-id-store";
import { storedExternalId, decimalExternalId } from "@/lib/external-ids";
import { greaderItemId, parseGReaderItemId } from "@/lib/greader";
import type { PrismaClient } from "@prisma/client";
const raw = db as unknown as PrismaClient;
beforeAll(async () => {
  execFileSync("node_modules/.bin/prisma", ["db", "push"], { env: { ...process.env, DATABASE_URL: fixture.url }, stdio: "pipe" });
  for (const id of ["u", "v"]) await db.user.create({ data: { id, email: `${id}@test.org` } });
  await db.apiToken.create({ data: { userId: "u", name: "test", tokenHash: "hash", feverKey: hashApiToken("key"), scope: "write" } });
}, 30000);
afterAll(async () => { await db.$disconnect(); rmSync(fixture.dir, { recursive: true, force: true }); });
async function call(values: Record<string, string>, multipart = false) {
  const body = multipart ? new FormData() : new URLSearchParams();
  for (const [key, value] of Object.entries({ api: "", api_key: "key", ...values })) body.set(key, value);
  const response = await POST(new Request("http://localhost/api/fever", { method: "POST", body }));
  expect(response.status).toBe(200);
  return response.text();
}
it("backfills in batches idempotently, assigns every insert operation and isolates users", async () => {
  const cat = await db.category.create({ data: { userId: "u", name: "Tech" } });
  const feed = await db.feed.create({ data: { userId: "u", categoryId: cat.id, name: "Feed", url: "https://example.org" } });
  const data = { userId: "u", feedId: feed.id, title: "a", content: "body", link: "https://example.org/a", publishedAt: new Date(0) };
  await db.article.createMany({ data: [data, data] });
  await db.article.createManyAndReturn({ data: [data] });
  await db.article.upsert({ where: { id: "upsert" }, create: { ...data, id: "upsert" }, update: {} });
  await db.article.create({ data: { ...data, id: "boundary", extId: storedExternalId("9007199254740993") } });
  await db.article.create({ data: { ...data, userId: "v", id: "private" } });
  const all = await db.article.findMany();
  expect(all.every(a => a.extId)).toBe(true);
  expect(new Set(all.map(a => a.extId)).size).toBe(all.length);
  // Simulate existing pre-upgrade rows and an interrupted batch.
  await db.article.updateMany({ where: { id: { notIn: ["boundary", "private"] } }, data: { extId: null } });
  await backfillExternalIds(raw, 2);
  const first = await db.article.findMany({ orderBy: { id: "asc" } });
  await backfillExternalIds(raw, 2);
  expect((await db.article.findMany({ orderBy: { id: "asc" } })).map(a => a.extId)).toEqual(first.map(a => a.extId));
  for (const id of ["9007199254740993", "9223372036854775807"]) {
    expect(parseGReaderItemId(greaderItemId(id))).toBe(id);
    expect(decimalExternalId(storedExternalId(id))).toBe(id);
  }
  const text = await call({ items: "", since_id: "0", feeds: "", groups: "", favicons: "", links: "" }, true);
  expect(text).toContain('"id":9007199254740993');
  const result = JSON.parse(text);
  expect(result.items).toHaveLength(5);
  expect(result.feeds_groups[0].feed_ids).toBe(decimalExternalId(feed.extId));
  expect(result.favicons[0].data).toMatch(/^data:image/);
  const range = JSON.parse(await call({ items: "", since_id: "9007199254740992", max_id: "9007199254740994" }));
  expect(range.items).toHaveLength(1);
  const marked = JSON.parse(await call({ mark: "item", as: "read", with_ids: `9007199254740993,${decimalExternalId(all.find(a => a.id === "private")!.extId)}` }));
  expect(marked.unread_item_ids.split(",")).not.toContain("9007199254740993");
  expect((await db.article.findUniqueOrThrow({ where: { id: "private" } })).isRead).toBe(false);
  expect((await db.article.findUniqueOrThrow({ where: { id: "boundary" } })).isRead).toBe(true);
  await call({ mark: "group", id: decimalExternalId(cat.extId), as: "read", before: "1" });
  expect(await db.article.count({ where: { userId: "u", isRead: false } })).toBe(5 - 1); // discovery is newer than before
});
it("returns complete reconciliation lists and bounded numeric pages with feed/group selectors", async () => {
  const feed = await db.feed.findFirstOrThrow({ where: { userId: "u" } });
  const data = { userId: "u", feedId: feed.id, title: "bulk", content: "body", link: "https://example.org/bulk", publishedAt: new Date(0), isStarred: true };
  for (let i = 0; i < 11; i++) await db.article.createMany({ data: Array.from({ length: 950 }, () => data) });
  const states = JSON.parse(await call({ unread_item_ids: "", saved_item_ids: "" }));
  expect(states.unread_item_ids.split(",").length).toBeGreaterThan(10000);
  expect(states.saved_item_ids.split(",")).toHaveLength(10450);
  const page = JSON.parse(await call({ items: "", since_id: "0", feed_ids: decimalExternalId(feed.extId) }));
  expect(page.items).toHaveLength(50);
  expect(page.items[0].id).toBeLessThan(page.items[49].id);
  const pivot = String(page.items[49].id);
  await db.article.deleteMany({ where: { userId: "u", extId: storedExternalId(pivot) } });
  const next = JSON.parse(await call({ items: "", since_id: pivot }));
  expect(next.items[0].id).toBeGreaterThan(Number(pivot));
  const group = await db.category.findFirstOrThrow({ where: { userId: "u" } });
  expect(JSON.parse(await call({ items: "", group_ids: decimalExternalId(group.extId) })).items).toHaveLength(50);
  expect(JSON.parse(await call({ items: "", feed_ids: "1" })).items).toEqual([]);
  const selected = states.saved_item_ids.split(",").slice(0, 100).join(",");
  expect(JSON.parse(await call({ items: "", with_ids: selected })).items).toHaveLength(50);
  await call({ mark: "feed", id: decimalExternalId(feed.extId), as: "read", before: String(Math.floor(Date.now() / 1000) + 1) });
  expect(await db.article.count({ where: { userId: "u", isRead: false } })).toBe(0);
}, 30000);
it("ignores invalid and padded IDs, treats group -1 as a no-op, and skips pending identities", async () => {
  const feed = await db.feed.findFirstOrThrow({ where: { userId: "u" } });
  const row = await db.article.create({ data: { userId: "u", feedId: feed.id, title: "input", content: "", link: "https://example.org/input", publishedAt: new Date() } });
  for (const id of ["-1", "bad", "9223372036854775808"]) {
    expect(JSON.parse(await call({ mark: "group", as: "read", id })).auth).toBe(1);
    expect(JSON.parse(await call({ items: "", with_ids: id })).items).toEqual([]);
  }
  expect((await db.article.findUniqueOrThrow({ where: { id: row.id } })).isRead).toBe(false);
  await call({ mark: "item", as: "read", with_ids: `bad, ${decimalExternalId(row.extId)} ,9223372036854775808` });
  expect((await db.article.findUniqueOrThrow({ where: { id: row.id } })).isRead).toBe(true);
  await db.article.update({ where: { id: row.id }, data: { extId: null } });
  expect(JSON.parse(await call({ items: "", feeds: "", groups: "", favicons: "" })).auth).toBe(1);
  await db.feed.update({ where: { id: feed.id }, data: { extId: null } });
  expect(JSON.parse(await call({ items: "", feeds: "", groups: "", favicons: "" })).feeds).toEqual([]);
  await backfillExternalIds(raw);
});
it("keeps successful authentication on server failures", async () => {
  const spy = vi.spyOn(db.article, "findMany").mockRejectedValueOnce(new Error("unavailable"));
  const response = await POST(new Request("http://localhost/api/fever?api&api_key=key&items"));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ auth: 1, error: "Internal server error" });
  spy.mockRestore();
});
