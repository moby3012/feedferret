// Single-article user-state toggles (read / unread, star / unstar, read-later / remove) must not move
// Article.updatedAt — the GReader `updated` / ot-nt clock that sync clients re-download by. Every
// per-article path (UI state ops, read-later route, REST v1, MCP, Fever, GReader edit-tag, Telegram
// mark-read link) runs here against a real database with the real routes and actions.
//
// Default: SQLite (temp file). Postgres: set FEEDFERRET_TEST_PG_URL to an EMPTY throwaway database
// (the test deletes rows in it) whose client was generated for the postgresql provider:
// `DATABASE_PROVIDER=postgresql pnpm run prisma:generate`. The schema is pushed into it. Afterwards run
// `pnpm run prisma:generate` again to restore the SQLite client/schema the other tests expect.
// Example (local container):
//   docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=x -e POSTGRES_DB=ff postgres:16-alpine
//   FEEDFERRET_TEST_PG_URL=postgresql://postgres:x@localhost:55432/ff pnpm exec vitest run --project unit tests/server/user-state-updated-at.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const h = vi.hoisted(() => {
  const provider: "sqlite" | "postgresql" = process.env.FEEDFERRET_TEST_PG_URL ? "postgresql" : "sqlite";
  process.env.DATABASE_PROVIDER = provider;
  return { db: null as unknown as PrismaClient, provider, user: "alice" as string | null };
});
vi.mock("@/lib/db", () => ({
  get db() {
    return h.db;
  },
  getDatabaseProvider: () => h.provider,
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => (h.user ? { user: { id: h.user } } : null)) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/greader", async (original) => ({
  ...(await original<typeof import("@/lib/greader")>()),
  authenticateGReaderRequest: vi.fn(async () => ({ id: "alice", email: "alice@example.org", apiTokenVersion: 0 })),
}));
vi.mock("@/lib/api-auth", async (original) => {
  const actual = await original<typeof import("@/lib/api-auth")>();
  const user = () => ({ id: "alice", email: "alice@example.org", name: "Alice", role: "USER", tokenScope: "write" });
  return { ...actual, resolveApiUser: vi.fn(async () => user()), requireApiUser: vi.fn(async () => user()) };
});
vi.mock("@/lib/rate-limit", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: () => ({ success: true }),
  peekRateLimit: () => ({ success: true }),
}));
vi.mock("@/lib/telegram-callback", async (original) => ({
  ...(await original<typeof import("@/lib/telegram-callback")>()),
  verifyMarkReadUrl: () => true,
}));

import { markWhereRead } from "../../server/articles/bulk-read";
import { applyArticleStateOps } from "../../app/actions/article-state";
import { POST as readLaterPost, DELETE as readLaterDelete } from "../../app/api/read-later/route";
import { PATCH as v1Patch, POST as v1Post } from "../../app/api/v1/[...path]/route";
import { POST as mcpPost } from "../../app/api/mcp/route";
import { POST as feverPost } from "../../app/api/fever/route";
import { POST as greaderPost } from "../../app/api/greader/[...path]/route";
import { GET as telegramGet } from "../../app/api/telegram/callback/route";
import { hashApiToken } from "../../lib/token";

const FEVER_KEY = "user-state-fever-key";
const T0 = new Date("2026-01-01T00:00:00.000Z");
const dir = mkdtempSync(join(tmpdir(), "feedferret-user-state-"));

beforeAll(async () => {
  if (h.provider === "postgresql") {
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const pg = (await import("pg")).default;
    const url = process.env.FEEDFERRET_TEST_PG_URL!;
    execFileSync("node", ["scripts/prepare-prisma-schema.mjs"], { env: { ...process.env, DATABASE_PROVIDER: "postgresql" }, stdio: "pipe" });
    execFileSync("node_modules/.bin/prisma", ["db", "push", "--schema", "prisma/schema.generated.prisma", "--accept-data-loss"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    h.db = new PrismaClient({ adapter: new PrismaPg(new pg.Pool({ connectionString: url })) });
    await h.db.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm").catch(() => {});
  } else {
    const url = `file:${join(dir, "test.db")}`;
    execFileSync("node_modules/.bin/prisma", ["db", "push", "--schema", "prisma/schema.generated.prisma"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    h.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: url.slice("file:".length) }) });
  }
  await h.db.article.deleteMany({});
  await h.db.feed.deleteMany({ where: { userId: { in: ["alice", "bob"] } } });
  await h.db.user.deleteMany({ where: { id: { in: ["alice", "bob"] } } });
  await h.db.user.create({ data: { id: "alice", email: "alice@example.org", apiFeverKey: hashApiToken(FEVER_KEY), apiPasswordHash: "x" } });
  await h.db.user.create({ data: { id: "bob", email: "bob@example.org" } });
  await h.db.feed.create({ data: { id: "f", extId: "0000000000000000001", userId: "alice", name: "F", url: "https://example.org/f" } });
}, 120_000);

afterAll(async () => {
  await h.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
/** A fresh article of alice's with `updatedAt` pinned to T0 (the value every toggle must leave alone). */
async function article(extra: Record<string, unknown> = {}) {
  const n = ++seq;
  const id = `s${String(n).padStart(4, "0")}`;
  await h.db.article.create({
    data: { id, extId: String(1000 + n).padStart(19, "0"), feedId: "f", userId: "alice", title: id, link: `https://example.org/${id}`, dedupeKey: id, content: "x", publishedAt: T0, createdAt: T0, updatedAt: T0, ...extra },
  });
  return { id, extId: String(1000 + n) };
}
const stateOf = (id: string) =>
  h.db.article.findUniqueOrThrow({ where: { id }, select: { updatedAt: true, isRead: true, readAt: true, isStarred: true, isReadLater: true, readLaterSavedAt: true } });
async function expectUpdatedAtKept(id: string) {
  expect((await stateOf(id)).updatedAt.getTime(), `updatedAt of ${id}`).toBe(T0.getTime());
}
const jsonReq = (path: string, body: unknown, method = "POST") => new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const form = (values: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values).toString() });

beforeEach(async () => {
  h.user = "alice";
  await h.db.article.deleteMany({});
});

describe("Article.updatedAt is the sync clock: user state must not move it", () => {
  it("control: a plain Prisma update does bump it, so the assertions below can fail", async () => {
    const a = await article();
    await h.db.article.update({ where: { id: a.id }, data: { title: "content change" } });
    expect((await stateOf(a.id)).updatedAt.getTime()).toBeGreaterThan(T0.getTime());
  });

  it("UI toggles (applyArticleStateOps): read, star and read-later, each direction, plus repeats keep readAt / readLaterSavedAt", async () => {
    const a = await article();
    await applyArticleStateOps([{ id: a.id, isRead: true, isStarred: true, isReadLater: true }]);
    let s = await stateOf(a.id);
    expect(s).toMatchObject({ isRead: true, isStarred: true, isReadLater: true });
    expect(s.readAt).toBeInstanceOf(Date);
    expect(s.readLaterSavedAt).toBeInstanceOf(Date);
    await expectUpdatedAtKept(a.id);

    const readAt = s.readAt;
    await applyArticleStateOps([{ id: a.id, isRead: true }]); // repeat: no change, readAt stable
    expect((await stateOf(a.id)).readAt).toEqual(readAt);

    await applyArticleStateOps([{ id: a.id, isRead: false, isStarred: false, isReadLater: false }]);
    s = await stateOf(a.id);
    expect(s).toMatchObject({ isRead: false, readAt: null, isStarred: false, isReadLater: false, readLaterSavedAt: null });
    await expectUpdatedAtKept(a.id);
  });

  it("read-later route: POST saves, DELETE removes; updatedAt untouched", async () => {
    const a = await article();
    const saved = await readLaterPost(jsonReq("/api/read-later", { articleId: a.id }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ id: a.id, isReadLater: true });
    expect((await stateOf(a.id)).isReadLater).toBe(true);
    await expectUpdatedAtKept(a.id);

    const removed = await readLaterDelete(jsonReq("/api/read-later", { articleId: a.id }, "DELETE"));
    expect(removed.status).toBe(200);
    expect((await stateOf(a.id)).isReadLater).toBe(false);
    await expectUpdatedAtKept(a.id);
  });

  it("REST v1: PATCH article and batch star / read_later (single and mixed), updatedAt untouched", async () => {
    const a = await article();
    const patch = await v1Patch(jsonReq(`/api/v1/articles/${a.id}`, { isRead: true, isStarred: true, isReadLater: true }, "PATCH"), { params: Promise.resolve({ path: ["articles", a.id] }) });
    expect(patch.status).toBe(200);
    expect(await stateOf(a.id)).toMatchObject({ isRead: true, isStarred: true, isReadLater: true });
    await expectUpdatedAtKept(a.id);

    for (const action of ["unstar", "remove_read_later", "unread"]) {
      const res = await v1Post(jsonReq("/api/v1/articles/batch", { ids: [a.id], action }), { params: Promise.resolve({ path: ["articles", "batch"] }) });
      expect(res.status, action).toBe(200);
      await expectUpdatedAtKept(a.id);
    }
    expect(await stateOf(a.id)).toMatchObject({ isRead: false, isStarred: false, isReadLater: false });

    const starred = await v1Post(jsonReq("/api/v1/articles/batch", { ids: [a.id], action: "star" }), { params: Promise.resolve({ path: ["articles", "batch"] }) });
    expect(starred.status).toBe(200);
    expect((await stateOf(a.id)).isStarred).toBe(true);
    await expectUpdatedAtKept(a.id);
  });

  it("MCP update_article_state and batch_update_articles (star), updatedAt untouched", async () => {
    const a = await article();
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await mcpPost(jsonReq("/api/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
      return (await res.json()).result as { isError?: boolean };
    };
    expect((await call("feedferret.update_article_state", { articleId: a.id, isRead: true, isReadLater: true })).isError).toBeFalsy();
    expect(await stateOf(a.id)).toMatchObject({ isRead: true, isReadLater: true });
    await expectUpdatedAtKept(a.id);

    expect((await call("feedferret.batch_update_articles", { ids: [a.id], action: "star" })).isError).toBeFalsy();
    expect((await stateOf(a.id)).isStarred).toBe(true);
    await expectUpdatedAtKept(a.id);
  });

  it("Fever mark=item (read, unread, saved, unsaved), updatedAt untouched", async () => {
    const a = await article();
    const mark = (as_: string) => feverPost(new Request("http://localhost/api/fever?api", form({ api_key: FEVER_KEY, mark: "item", as: as_, id: a.extId })));
    expect((await mark("read")).status).toBe(200);
    expect(await stateOf(a.id)).toMatchObject({ isRead: true });
    await expectUpdatedAtKept(a.id);
    expect((await mark("saved")).status).toBe(200);
    expect((await stateOf(a.id)).isStarred).toBe(true);
    await expectUpdatedAtKept(a.id);
    expect((await mark("unsaved")).status).toBe(200);
    expect((await mark("unread")).status).toBe(200);
    expect(await stateOf(a.id)).toMatchObject({ isRead: false, isStarred: false });
    await expectUpdatedAtKept(a.id);
  });

  it("GReader edit-tag (read, starred, and removals), updatedAt untouched", async () => {
    const a = await article();
    const edit = (add: string, remove?: string) =>
      greaderPost(new Request("http://localhost/api/greader/reader/api/0/edit-tag", form({ i: a.extId, a: add, ...(remove ? { r: remove } : {}) })), {
        params: Promise.resolve({ path: ["reader", "api", "0", "edit-tag"] }),
      });
    expect((await edit("user/-/state/com.google/read")).status).toBe(200);
    expect((await stateOf(a.id)).isRead).toBe(true);
    await expectUpdatedAtKept(a.id);
    expect((await edit("user/-/state/com.google/starred")).status).toBe(200);
    expect((await stateOf(a.id)).isStarred).toBe(true);
    await expectUpdatedAtKept(a.id);
    expect((await edit("", "user/-/state/com.google/read")).status).toBe(200);
    expect(await stateOf(a.id)).toMatchObject({ isRead: false, readAt: null });
    await expectUpdatedAtKept(a.id);
  });

  it("Telegram mark-as-read link marks the article read; updatedAt untouched", async () => {
    const a = await article();
    const res = await telegramGet(new Request(`http://localhost/api/telegram/callback?id=${a.id}&uid=alice&exp=9999999999&sig=x`));
    expect(res.status).toBe(200);
    expect(await stateOf(a.id)).toMatchObject({ isRead: true });
    await expectUpdatedAtKept(a.id);
  });

  it("bulk mark-read (#284 path) still leaves updatedAt untouched on the same database", async () => {
    const a = await article();
    await markWhereRead("alice", { id: a.id });
    expect((await stateOf(a.id)).isRead).toBe(true);
    await expectUpdatedAtKept(a.id);
  });
});
