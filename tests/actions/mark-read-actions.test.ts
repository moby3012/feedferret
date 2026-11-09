import { describe, it, expect, vi, beforeEach } from "vitest";
import * as actions from "../../app/actions/feeds";
import { clearUndoTokens } from "../../lib/undo-tokens";

// ── mocks ────────────────────────────────────────────────────────────────────
// A tiny in-memory article table that honours the parts of the Prisma `where`
// the mark-read actions use, so ownership is tested by behaviour, not by
// inspecting the query shape.
type Row = { id: string; userId: string; feedId: string; isRead: boolean; readAt: Date | null };

const h = vi.hoisted(() => {
  const store = { rows: [] as Row[], currentUser: "alice" as string | null };
  const matches = (row: Row, where: any): boolean => {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.isRead !== undefined && row.isRead !== where.isRead) return false;
    if (where.feedId !== undefined && row.feedId !== where.feedId) return false;
    if (where.readAt instanceof Date && row.readAt?.getTime() !== where.readAt.getTime()) return false;
    return true;
  };
  const dbMock = {
    article: {
      findMany: vi.fn(async ({ where }: any) => store.rows.filter((r) => matches(r, where)).map((r) => ({ id: r.id }))),
      count: vi.fn(async ({ where }: any) => store.rows.filter((r) => matches(r, where)).length),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = store.rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
    user: { findUnique: vi.fn(async () => ({ hideDuplicates: true })) },
    savedSearch: { findUnique: vi.fn(async () => null) },
    // Interactive transaction: all-or-nothing, like the real thing.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = store.rows.map((r) => ({ ...r }));
      try {
        return await fn(dbMock);
      } catch (err) {
        store.rows = snapshot;
        throw err;
      }
    }),
  };
  return { store, dbMock };
});
const { store, dbMock } = h;

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => (h.store.currentUser ? { user: { id: h.store.currentUser } } : null)),
}));
vi.mock("@/lib/db", () => ({ db: h.dbMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/search", () => ({ buildAdvancedSearchWhere: vi.fn(async () => ({})) }));
// Heavy modules feeds.ts imports at top level; irrelevant to these actions.
vi.mock("@/lib/rss-sync", () => ({}));
vi.mock("@/lib/feed-fetcher", () => ({}));
vi.mock("@/lib/ssrf", () => ({}));
vi.mock("@/lib/feed-extraction", () => ({}));
vi.mock("@/lib/page-feed-suggest", () => ({}));
vi.mock("@/lib/page-feed-create", () => ({}));
vi.mock("@/lib/webhooks", () => ({}));
vi.mock("@/lib/retention", () => ({}));
vi.mock("@/lib/crypto", () => ({}));
vi.mock("@/lib/ai-summary", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ RATE_LIMITS: {} }));
vi.mock("@/lib/logger", () => ({ logger: {} }));
vi.mock("@/lib/sanitize-html", () => ({}));
vi.mock("@/lib/full-text-fetch", () => ({}));


function seed() {
  store.rows = [
    { id: "a1", userId: "alice", feedId: "f1", isRead: false, readAt: null },
    { id: "a2", userId: "alice", feedId: "f1", isRead: false, readAt: null },
    { id: "a3", userId: "alice", feedId: "f2", isRead: false, readAt: null },
    { id: "a4", userId: "alice", feedId: "f1", isRead: true, readAt: new Date(0) },
    { id: "b1", userId: "bob", feedId: "g1", isRead: true, readAt: new Date(0) },
    { id: "b2", userId: "bob", feedId: "g1", isRead: false, readAt: null },
  ];
}
const state = () => Object.fromEntries(store.rows.map((r) => [r.id, r.isRead]));

beforeEach(() => {
  store.currentUser = "alice";
  seed();
  clearUndoTokens();
  vi.clearAllMocks();
});

describe("markAllAsRead", () => {
  it("returns exactly the ids it changed and leaves already-read and foreign rows alone", async () => {
    const { ids, undoToken } = await actions.markAllAsRead({ feedId: "f1", category: null });
    expect(ids.sort()).toEqual(["a1", "a2"]);
    expect(undoToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(state()).toMatchObject({ a1: true, a2: true, a3: false, a4: true, b1: true, b2: false });
  });

  it("never touches another user's articles, even for a global scope", async () => {
    const { ids } = await actions.markAllAsRead();
    expect(ids.sort()).toEqual(["a1", "a2", "a3"]);
    expect(state().b2).toBe(false);
  });

  it.each(["Recently Read", "Spoiler"])("is a no-op for the read-only view %s", async (category) => {
    const result = await actions.markAllAsRead({ feedId: null, category });
    expect(result).toEqual({ ids: [], undoToken: null });
    expect(dbMock.article.updateMany).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ a1: false, a2: false, a3: false });
  });

  it("builds its selection from the same view scope as the list (search + feed)", async () => {
    await actions.markAllAsRead({ feedId: "f2", category: null, search: " cats " });
    const where = dbMock.article.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: "alice", feedId: "f2", isRead: false });
    expect(state()).toMatchObject({ a1: false, a2: false, a3: true });
  });

  it("is atomic: a failing chunk leaves every article unread and issues no undo token", async () => {
    store.rows = Array.from({ length: 1200 }, (_, i) => ({
      id: `big${i}`, userId: "alice", feedId: "f1", isRead: false, readAt: null as Date | null,
    }));
    let calls = 0;
    const real = dbMock.article.updateMany.getMockImplementation()!;
    dbMock.article.updateMany.mockImplementation(async (args: any) => {
      if (++calls === 2) throw new Error("db went away");
      return real(args);
    });
    await expect(actions.markAllAsRead({ feedId: "f1", category: null })).rejects.toThrow("db went away");
    expect(store.rows.every((r) => !r.isRead)).toBe(true);
    dbMock.article.updateMany.mockImplementation(real);
  });

  it("requires a session", async () => {
    store.currentUser = null;
    await expect(actions.markAllAsRead()).rejects.toThrow("Unauthorized");
  });
});

describe("markArticlesAsUnread (undo via server-side token)", () => {
  it("restores exactly the articles mark-all changed", async () => {
    const { undoToken } = await actions.markAllAsRead({ feedId: "f1", category: null });
    const { count, ids } = await actions.markArticlesAsUnread(undoToken!);
    expect(count).toBe(2);
    expect(ids.sort()).toEqual(["a1", "a2"]);
    // a4 was read before mark-all and must still be read afterwards.
    expect(state()).toMatchObject({ a1: false, a2: false, a3: false, a4: true });
  });

  it("only restores articles that are still read (not ones the user already re-opened)", async () => {
    const { undoToken } = await actions.markAllAsRead({ feedId: "f1", category: null });
    store.rows.find((r) => r.id === "a1")!.isRead = false; // user toggled it back by hand
    const { ids } = await actions.markArticlesAsUnread(undoToken!);
    expect(ids).toEqual(["a2"]);
  });

  it("a token cannot be replayed", async () => {
    const { undoToken } = await actions.markAllAsRead({ feedId: "f1", category: null });
    await actions.markArticlesAsUnread(undoToken!);
    await expect(actions.markArticlesAsUnread(undoToken!)).rejects.toThrow("Undo expired");
  });

  it("another user cannot use (or learn about) someone else's token", async () => {
    const { undoToken } = await actions.markAllAsRead({ feedId: "f1", category: null });
    store.currentUser = "bob";
    await expect(actions.markArticlesAsUnread(undoToken!)).rejects.toThrow("Undo expired");
    store.currentUser = "alice";
    expect((await actions.markArticlesAsUnread(undoToken!)).count).toBe(2); // still valid for alice
  });

  it("rejects malformed / unknown tokens without touching the database", async () => {
    for (const bad of ["", "a1", "x".repeat(500), "../../etc/passwd", ["a1"] as unknown as string, undefined as unknown as string]) {
      await expect(actions.markArticlesAsUnread(bad)).rejects.toThrow("Undo expired");
    }
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it("expires after the TTL", async () => {
    vi.useFakeTimers();
    try {
      const { undoToken } = await actions.markAllAsRead({ feedId: "f1", category: null });
      vi.advanceTimersByTime(10 * 60 * 1000 + 1000);
      await expect(actions.markArticlesAsUnread(undoToken!)).rejects.toThrow("Undo expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("chunks very large id lists below SQLite's bound-variable limit", async () => {
    store.rows = Array.from({ length: 1200 }, (_, i) => ({
      id: `big${i}`, userId: "alice", feedId: "f1", isRead: false, readAt: null as Date | null,
    }));
    const { undoToken, ids } = await actions.markAllAsRead({ feedId: "f1", category: null });
    expect(ids).toHaveLength(1200);
    dbMock.article.updateMany.mockClear();
    await actions.markArticlesAsUnread(undoToken!);
    const sizes = dbMock.article.updateMany.mock.calls.map((c: any[]) => c[0].where.id.in.length);
    expect(sizes).toEqual([500, 500, 200]);
  });

  it("requires a session", async () => {
    store.currentUser = null;
    await expect(actions.markArticlesAsUnread("x".repeat(32))).rejects.toThrow("Unauthorized");
  });
});

describe("getViewUnreadCount", () => {
  it("counts the whole view for the signed-in user (not a capped page)", async () => {
    expect(await actions.getViewUnreadCount("f1")).toBe(2);
    expect(await actions.getViewUnreadCount(null, "All")).toBe(3);
    store.currentUser = "bob";
    expect(await actions.getViewUnreadCount(null, "All")).toBe(1);
  });

  it("is 0 for read-only views instead of counting unrelated unread articles", async () => {
    expect(await actions.getViewUnreadCount(null, "Recently Read")).toBe(0);
    expect(await actions.getViewUnreadCount(null, "Spoiler")).toBe(0);
  });

  it("requires a session", async () => {
    store.currentUser = null;
    await expect(actions.getViewUnreadCount()).rejects.toThrow("Unauthorized");
  });
});
