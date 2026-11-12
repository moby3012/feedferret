// Bulk "mark all read" + Undo against a real SQLite DB (server/articles/bulk-read.ts):
// set-based chunked writes, arrival cutoff, user isolation, starred / updatedAt untouched,
// bounded statement count at 20 k rows, concurrent writers, partial failure.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const h = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  user: "alice" as string | null,
  statements: 0,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return h.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => (h.user ? { user: { id: h.user } } : null)) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { markAllAsRead, markArticlesAsUnread } from "../../app/actions/feeds";
import { markArticleIdsRead } from "../../app/actions/article-state";
import { BULK_READ_CHUNK, parseCutoffMs } from "../../server/articles/bulk-read";

const CHUNK = BULK_READ_CHUNK.sqlite;
import { clearUndoTokens } from "../../lib/undo-tokens";

const dir = mkdtempSync(join(tmpdir(), "feedferret-mark-all-"));
const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const at = (min: number) => new Date(T0 + min * 60_000);

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("node_modules/.bin/prisma", ["db", "push", "--schema", "prisma/schema.generated.prisma"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  const client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: url.slice("file:".length) }), log: [{ emit: "event", level: "query" }] });
  client.$on("query", () => {
    h.statements++;
  });
  h.db = client;
  await h.db.user.create({ data: { id: "alice", email: "alice@example.org" } });
  await h.db.user.create({ data: { id: "bob", email: "bob@example.org" } });
  await h.db.feed.create({ data: { id: "big", userId: "alice", name: "Big", url: "https://example.org/big" } });
  await h.db.feed.create({ data: { id: "small", userId: "alice", name: "Small", url: "https://example.org/small" } });
  await h.db.feed.create({ data: { id: "bobs", userId: "bob", name: "Bob", url: "https://example.org/bob" } });
}, 60_000);

afterAll(async () => {
  await h.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  h.user = "alice";
  clearUndoTokens();
  await h.db.article.deleteMany({});
});

let seq = 0;
function row(feedId: string, userId: string, extra: Record<string, unknown> = {}) {
  const id = `r${++seq}`;
  return { id, extId: String(seq).padStart(19, "0"), feedId, userId, title: `t ${id}`, link: `https://example.org/${id}`, dedupeKey: id, content: "<p>x</p>", publishedAt: at(0), createdAt: at(0), updatedAt: at(0), ...extra };
}
async function seed(rows: Array<Record<string, unknown>>) {
  for (let i = 0; i < rows.length; i += 2000) await h.db.article.createMany({ data: rows.slice(i, i + 2000) as never });
  return rows.map((r) => r.id as string);
}
const unread = (where: Record<string, unknown> = {}) => h.db.article.count({ where: { isRead: false, ...where } });

describe("markAllAsRead at scale (20 k rows)", () => {
  it("is set-based: bounded statements, well inside the time budget, updatedAt untouched, Undo restores everything", async () => {
    await seed(Array.from({ length: 20_000 }, () => row("big", "alice")));
    h.statements = 0;
    const t0 = performance.now();
    const result = await markAllAsRead({ feedId: "big", cutoff: Date.now() });
    const ms = performance.now() - t0;
    expect(result.count).toBe(20_000);
    // Large results ship no id list (the client patched its rows by scope).
    expect(result).toMatchObject({ ids: [], idsTruncated: true });
    expect(result.undoToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    // 1 prefs lookup + 1 candidate SELECT + one UPDATE … RETURNING per chunk (+ slack for search prefs).
    expect(h.statements).toBeLessThanOrEqual(4 + Math.ceil(20_000 / CHUNK));
    expect(ms).toBeLessThan(10_000);
    expect(await unread({ feedId: "big" })).toBe(0);
    // Read state never moves the GReader `updated` / ot clock.
    expect(await h.db.article.count({ where: { updatedAt: { not: at(0) } } })).toBe(0);
    expect(await h.db.article.count({ where: { readAt: null } })).toBe(0);

    h.statements = 0;
    const undo = await markArticlesAsUnread(result.undoToken!);
    expect(undo.count).toBe(20_000);
    expect(h.statements).toBeLessThanOrEqual(1 + Math.ceil(20_000 / CHUNK));
    expect(await unread({ feedId: "big" })).toBe(20_000);
    expect(await h.db.article.count({ where: { updatedAt: { not: at(0) } } })).toBe(0);
  }, 60_000);
});

describe("markAllAsRead correctness", () => {
  it("respects the arrival cutoff, other users, starred flags and already-read rows", async () => {
    const [before1, before2] = await seed([row("small", "alice", { isStarred: true }), row("small", "alice")]);
    const [after] = await seed([row("small", "alice", { createdAt: at(10) })]);
    const [old] = await seed([row("small", "alice", { isRead: true, readAt: at(-5) })]);
    const [foreign] = await seed([row("bobs", "bob")]);
    const result = await markAllAsRead({ category: "All", cutoff: at(5).getTime() });
    expect(result.ids.sort()).toEqual([before1, before2].sort());
    expect(result.count).toBe(2);
    const get = (id: string) => h.db.article.findUniqueOrThrow({ where: { id } });
    expect((await get(after)).isRead).toBe(false); // arrived after the list snapshot
    expect((await get(foreign)).isRead).toBe(false); // another user
    expect((await get(before1)).isStarred).toBe(true); // star untouched
    expect((await get(old)).readAt).toEqual(at(-5)); // already read: readAt kept
  });

  it("without a cutoff uses the request time (a row arriving later stays unread)", async () => {
    await seed([row("small", "alice", { createdAt: new Date(Date.now() + 60_000) })]);
    expect((await markAllAsRead({ feedId: "small" })).count).toBe(0);
  });

  it("clamps a client cutoff from the future to the server time and rejects garbage", async () => {
    expect(parseCutoffMs(Date.now() + 3_600_000, 1000)?.getTime()).toBe(1000);
    expect(parseCutoffMs(undefined)).toBeNull();
    expect(parseCutoffMs("123")).toBeUndefined();
    await expect(markAllAsRead({ feedId: "small", cutoff: "soon" as never })).rejects.toThrow("Invalid cutoff");
  });

  it("never touches another user's articles, even for a global scope or a foreign feed id", async () => {
    await seed([row("bobs", "bob"), row("bobs", "bob")]);
    expect((await markAllAsRead()).count).toBe(0);
    expect((await markAllAsRead({ feedId: "bobs" })).count).toBe(0);
    expect(await unread({ userId: "bob" })).toBe(2);
  });

  it.each(["Recently Read", "Spoiler"])("is a no-op for the read-only view %s", async (category) => {
    await seed([row("small", "alice")]);
    expect(await markAllAsRead({ feedId: null, category })).toEqual({ count: 0, ids: [], undoToken: null });
    expect(await unread()).toBe(1);
  });

  it("builds its selection from the same view scope as the list (search + feed)", async () => {
    const [cat] = await seed([row("small", "alice", { title: "all about cats" })]);
    await seed([row("small", "alice", { title: "dogs" }), row("big", "alice", { title: "cats elsewhere" })]);
    const result = await markAllAsRead({ feedId: "small", category: null, search: " cats " });
    expect(result.ids).toEqual([cat]);
  });

  it("returns only the rows it changed when another writer flips one in between (UPDATE … RETURNING)", async () => {
    const ids = await seed([row("small", "alice"), row("small", "alice"), row("small", "alice")]);
    const original = h.db.$queryRaw.bind(h.db);
    const spy = vi.spyOn(h.db, "$queryRaw").mockImplementationOnce(((...args: Parameters<typeof h.db.$queryRaw>) =>
      // A concurrent toggle (other tab / GReader client) lands between the SELECT and the UPDATE.
      h.db.article.updateMany({ where: { id: ids[1] }, data: { isRead: true, readAt: at(1) } }).then(() => original(...args))) as never);
    const result = await markAllAsRead({ feedId: "small", cutoff: Date.now() });
    spy.mockRestore();
    expect(result.ids.sort()).toEqual([ids[0], ids[2]].sort());
    await markArticlesAsUnread(result.undoToken!);
    // Undo restores this call's rows only; the other writer's read stays.
    expect((await h.db.article.findUniqueOrThrow({ where: { id: ids[1] } })).isRead).toBe(true);
  });

  it("a failure in the first chunk changes nothing; a later one returns the partial result with its Undo", async () => {
    await seed(Array.from({ length: CHUNK + 10 }, () => row("big", "alice")));
    const spy = vi.spyOn(h.db, "$queryRaw").mockRejectedValueOnce(new Error("db went away"));
    await expect(markAllAsRead({ feedId: "big" })).rejects.toThrow("db went away");
    expect(await unread()).toBe(CHUNK + 10);
    spy.mockRestore();

    const original = h.db.$queryRaw.bind(h.db);
    let calls = 0;
    const spy2 = vi.spyOn(h.db, "$queryRaw").mockImplementation(((...args: Parameters<typeof h.db.$queryRaw>) =>
      ++calls === 2 ? Promise.reject(new Error("db went away")) : original(...args)) as never);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const partial = await markAllAsRead({ feedId: "big" });
    spy2.mockRestore();
    errors.mockRestore();
    expect(partial).toMatchObject({ count: CHUNK, incomplete: true });
    expect(await unread()).toBe(10);
    expect((await markArticlesAsUnread(partial.undoToken!)).count).toBe(CHUNK);
    expect(await unread()).toBe(CHUNK + 10);
  });

  it("requires a session", async () => {
    h.user = null;
    await expect(markAllAsRead()).rejects.toThrow("Unauthorized");
  });
});

describe("concurrency with a feed sync", () => {
  it("items a sync inserts after the snapshot (also while mark-all runs) stay unread", async () => {
    await seed(Array.from({ length: 8000 }, () => row("big", "alice")));
    const cutoff = Date.now(); // the list snapshot
    await new Promise((r) => setTimeout(r, 5));
    let running = true;
    const inserted: string[] = [];
    const sync = (async () => {
      while (running) {
        const batch = Array.from({ length: 5 }, () => row("small", "alice", { createdAt: new Date(), updatedAt: new Date() }));
        await h.db.article.createMany({ data: batch as never });
        inserted.push(...batch.map((b) => b.id));
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    const result = await markAllAsRead({ category: "All", cutoff });
    running = false;
    await sync;
    expect(result.count).toBe(8000);
    expect(inserted.length).toBeGreaterThan(0);
    expect(await h.db.article.count({ where: { id: { in: inserted }, isRead: true } })).toBe(0);
  }, 60_000);
});

describe("explicit ids (Alles bis hier) share the chunked writer", () => {
  it("marks only own unread ids, returns them, and keeps updatedAt", async () => {
    const ids = await seed([row("small", "alice"), row("small", "alice", { isRead: true, readAt: at(-1) })]);
    const [foreign] = await seed([row("bobs", "bob")]);
    const result = await markArticleIdsRead([...ids, foreign]);
    expect(result.ids).toEqual([ids[0]]);
    expect((await h.db.article.findUniqueOrThrow({ where: { id: foreign } })).isRead).toBe(false);
    expect((await h.db.article.findUniqueOrThrow({ where: { id: ids[0] } })).updatedAt).toEqual(at(0));
  });

  it("stores readAt in the same format Prisma writes (Recently Read sorts on it)", async () => {
    const [raw, viaPrisma] = await seed([row("small", "alice"), row("small", "alice")]);
    await markArticleIdsRead([raw]);
    const stamp = (await h.db.article.findUniqueOrThrow({ where: { id: raw } })).readAt!;
    await h.db.article.update({ where: { id: viaPrisma }, data: { isRead: true, readAt: stamp } });
    const rows = await h.db.$queryRawUnsafe<Array<{ id: string; readAt: unknown; t: string }>>(`SELECT id, "readAt", typeof("readAt") AS t FROM "Article" WHERE id IN ('${raw}', '${viaPrisma}')`);
    expect(new Set(rows.map((r) => `${r.t}:${String(r.readAt)}`)).size).toBe(1);
  });
});
