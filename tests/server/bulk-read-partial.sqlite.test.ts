// Partial bulk read-state writes (a later chunk fails after earlier chunks committed) must never
// look like success: GReader / Fever answer a retryable 503, REST v1 an explicit partial 503 with
// counts, MCP a tool error, the UI action / Undo `incomplete` (+ a retry token for Undo). A retry
// of the same request finishes the job. Also: deadlock victims are retried. Real SQLite DB.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const h = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock("@/lib/db", () => ({
  get db() {
    return h.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "alice" } })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/greader", async (original) => ({
  ...(await original<typeof import("@/lib/greader")>()),
  authenticateGReaderRequest: vi.fn(async () => ({ id: "alice", email: "alice@example.org", apiTokenVersion: 0 })),
}));
vi.mock("@/lib/api-auth", async (original) => {
  const actual = await original<typeof import("@/lib/api-auth")>();
  const user = () => ({ id: "alice", email: "alice@example.org", name: "Alice", role: "USER" });
  return { ...actual, resolveApiUser: vi.fn(async () => user()), requireApiUser: vi.fn(async () => user()) };
});
vi.mock("@/lib/rate-limit", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: () => ({ success: true }),
  peekRateLimit: () => ({ success: true }),
}));

import { markAllAsRead, markArticlesAsUnread } from "../../app/actions/feeds";
import { BULK_READ_CHUNK, isRetryableDbError, markWhereRead } from "../../server/articles/bulk-read";
import { POST as greaderPost } from "../../app/api/greader/[...path]/route";
import { POST as feverPost } from "../../app/api/fever/route";
import { POST as v1Post } from "../../app/api/v1/[...path]/route";
import { POST as mcpPost } from "../../app/api/mcp/route";
import { hashApiToken } from "../../lib/token";
import { clearUndoTokens } from "../../lib/undo-tokens";

const CHUNK = BULK_READ_CHUNK.sqlite;
const TOTAL = CHUNK + 10;
const FEVER_KEY = "partial-test-fever-key";
const dir = mkdtempSync(join(tmpdir(), "feedferret-bulk-partial-"));

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("node_modules/.bin/prisma", ["db", "push", "--schema", "prisma/schema.generated.prisma"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  h.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: url.slice("file:".length) }) });
  await h.db.user.create({ data: { id: "alice", email: "alice@example.org", apiFeverKey: hashApiToken(FEVER_KEY), apiPasswordHash: "x" } });
  await h.db.feed.create({ data: { id: "f", extId: "0000000000000000001", userId: "alice", name: "F", url: "https://example.org/f" } });
}, 60_000);

afterAll(async () => {
  await h.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  clearUndoTokens();
  vi.restoreAllMocks();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await h.db.article.deleteMany({});
  const created = new Date(Date.now() - 3_600_000);
  const rows = Array.from({ length: TOTAL }, (_, i) => {
    const id = `a${String(i).padStart(6, "0")}`;
    return { id, extId: String(1000 + i).padStart(19, "0"), feedId: "f", userId: "alice", title: id, link: `https://example.org/${id}`, dedupeKey: id, content: "x", publishedAt: created, createdAt: created, updatedAt: created };
  });
  await h.db.article.createMany({ data: rows });
});

const unread = () => h.db.article.count({ where: { isRead: false } });

/** The second chunk write fails once (after the first committed); later calls go through. */
function failSecondChunk() {
  const original = h.db.$queryRaw.bind(h.db);
  let calls = 0;
  return vi.spyOn(h.db, "$queryRaw").mockImplementation(((...args: Parameters<typeof h.db.$queryRaw>) =>
    ++calls === 2 ? Promise.reject(new Error("db went away")) : original(...args)) as never);
}

const form = (values: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values).toString() });

describe("a later chunk fails after the first committed", () => {
  it("GReader mark-all-as-read answers a retryable 503; the retry finishes it", async () => {
    const call = () =>
      greaderPost(new Request("http://localhost/api/greader/reader/api/0/mark-all-as-read", form({ s: "user/-/state/com.google/reading-list" })), {
        params: Promise.resolve({ path: ["reader", "api", "0", "mark-all-as-read"] }),
      });
    const spy = failSecondChunk();
    const partial = await call();
    spy.mockRestore();
    expect(partial.status).toBe(503);
    expect(partial.headers.get("retry-after")).toBe("1");
    expect(await unread()).toBe(10);
    expect((await call()).status).toBe(200);
    expect(await unread()).toBe(0);
  });

  it("Fever mark=group answers a retryable 503; the retry finishes it", async () => {
    const call = () => feverPost(new Request("http://localhost/api/fever?api", form({ api_key: FEVER_KEY, mark: "group", as: "read", id: "0", before: String(Math.floor(Date.now() / 1000)) })));
    const spy = failSecondChunk();
    const partial = await call();
    spy.mockRestore();
    expect(partial.status).toBe(503);
    expect(await unread()).toBe(10);
    expect((await call()).status).toBe(200);
    expect(await unread()).toBe(0);
  });

  it("REST v1 mark-all-read answers an explicit partial 503 with counts; the retry finishes it", async () => {
    const call = () =>
      v1Post(new Request("http://localhost/api/v1/articles/mark-all-read", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), {
        params: Promise.resolve({ path: ["articles", "mark-all-read"] }),
      });
    const spy = failSecondChunk();
    const partial = await call();
    spy.mockRestore();
    expect(partial.status).toBe(503);
    expect(await partial.json()).toMatchObject({ updated: CHUNK, remaining: 10, incomplete: true });
    const done = await call();
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ updated: 10 });
  });

  it("MCP mark_all_read returns a tool error naming the counts; re-running finishes it", async () => {
    const call = async () => {
      const res = await mcpPost(new Request("http://localhost/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feedferret.mark_all_read", arguments: {} } }) }));
      return (await res.json()).result as { isError?: boolean; content: Array<{ text: string }> };
    };
    const spy = failSecondChunk();
    const partial = await call();
    spy.mockRestore();
    expect(partial.isError).toBe(true);
    expect(partial.content[0].text).toContain(`${CHUNK} done, 10 left`);
    expect((await call()).isError).toBeFalsy();
    expect(await unread()).toBe(0);
  });

  it("UI mark-all returns incomplete (with an Undo for what changed); re-running the same request finishes it", async () => {
    const spy = failSecondChunk();
    const partial = await markAllAsRead({ feedId: "f" });
    spy.mockRestore();
    expect(partial).toMatchObject({ count: CHUNK, incomplete: true });
    expect(partial.undoToken).toBeTruthy();
    expect((await markAllAsRead({ feedId: "f" })).count).toBe(10);
    expect(await unread()).toBe(0);
  });

  it("Undo that fails after one committed chunk keeps the rest under a retry token; the retry restores it", async () => {
    const marked = await markAllAsRead({ feedId: "f" });
    expect(await unread()).toBe(0);
    const spy = failSecondChunk();
    const partial = await markArticlesAsUnread(marked.undoToken!);
    spy.mockRestore();
    expect(partial).toMatchObject({ count: CHUNK, incomplete: true });
    expect(partial.retryToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(await unread()).toBe(CHUNK);
    // The original token is spent for the restored rows; the retry token covers exactly the rest.
    await expect(markArticlesAsUnread(marked.undoToken!)).rejects.toThrow("Undo expired");
    const rest = await markArticlesAsUnread(partial.retryToken!);
    expect(rest).toMatchObject({ count: 10 });
    expect(rest.incomplete).toBeUndefined();
    expect(await unread()).toBe(TOTAL);
  });
});

describe("deadlock / serialization victims", () => {
  it("recognises Postgres deadlock and serialization errors (also wrapped) but not others", () => {
    expect(isRetryableDbError({ code: "P2010", meta: { code: "40P01", message: "deadlock detected" } })).toBe(true);
    expect(isRetryableDbError(new Error("could not serialize access due to concurrent update"))).toBe(true);
    expect(isRetryableDbError({ message: "x", cause: { code: "40P01" } })).toBe(true);
    expect(isRetryableDbError({ code: "P2034" })).toBe(true);
    expect(isRetryableDbError(new Error("db went away"))).toBe(false);
  });

  it("retries a chunk the database aborted as a deadlock victim — the call completes", async () => {
    const original = h.db.$queryRaw.bind(h.db);
    let calls = 0;
    const spy = vi.spyOn(h.db, "$queryRaw").mockImplementation(((...args: Parameters<typeof h.db.$queryRaw>) =>
      ++calls <= 2 ? Promise.reject(Object.assign(new Error("deadlock detected"), { code: "P2010", meta: { code: "40P01" } })) : original(...args)) as never);
    const result = await markWhereRead("alice", { feedId: "f" });
    spy.mockRestore();
    expect(result).toMatchObject({ complete: true });
    expect(result.ids).toHaveLength(TOTAL);
    expect(errors).not.toHaveBeenCalled();
  });
});
