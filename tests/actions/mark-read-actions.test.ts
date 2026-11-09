import { describe, it, expect, vi, beforeEach } from "vitest";
import * as actions from "../../app/actions/feeds";

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
  vi.clearAllMocks();
});

describe("markAllAsRead", () => {
  it("returns exactly the ids it changed and leaves already-read and foreign rows alone", async () => {
    const { ids } = await actions.markAllAsRead({ feedId: "f1", category: null });
    expect(ids.sort()).toEqual(["a1", "a2"]);
    expect(state()).toMatchObject({ a1: true, a2: true, a3: false, a4: true, b1: true, b2: false });
  });

  it("never touches another user's articles, even for a global scope", async () => {
    const { ids } = await actions.markAllAsRead();
    expect(ids.sort()).toEqual(["a1", "a2", "a3"]);
    expect(state().b2).toBe(false);
  });

  it("requires a session", async () => {
    store.currentUser = null;
    await expect(actions.markAllAsRead()).rejects.toThrow("Unauthorized");
  });
});

describe("markArticlesAsUnread (undo)", () => {
  it("restores exactly the ids mark-all returned", async () => {
    const { ids } = await actions.markAllAsRead({ feedId: "f1", category: null });
    const { count } = await actions.markArticlesAsUnread(ids);
    expect(count).toBe(2);
    // a4 was read before mark-all and must still be read afterwards.
    expect(state()).toMatchObject({ a1: false, a2: false, a3: false, a4: true });
  });

  it("cannot touch other users' articles (ids from another account are ignored)", async () => {
    const { count } = await actions.markArticlesAsUnread(["b1", "a4"]);
    expect(count).toBe(1);
    expect(state().b1).toBe(true); // bob's read article stays read
    expect(state().a4).toBe(false);
  });

  it("handles empty / invalid input without hitting the database", async () => {
    expect(await actions.markArticlesAsUnread([])).toEqual({ count: 0 });
    expect(await actions.markArticlesAsUnread(undefined as unknown as string[])).toEqual({ count: 0 });
    expect(dbMock.article.updateMany).not.toHaveBeenCalled();
  });

  it("chunks very large id lists below SQLite's bound-variable limit", async () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `x${i}`);
    await actions.markArticlesAsUnread(ids);
    const sizes = dbMock.article.updateMany.mock.calls.map((c: any[]) => c[0].where.id.in.length);
    expect(sizes).toEqual([500, 500, 200]);
  });

  it("requires a session", async () => {
    store.currentUser = null;
    await expect(actions.markArticlesAsUnread(["a1"])).rejects.toThrow("Unauthorized");
  });
});

describe("getViewUnreadCount", () => {
  it("counts the whole view for the signed-in user (not a capped page)", async () => {
    expect(await actions.getViewUnreadCount("f1")).toBe(2);
    expect(await actions.getViewUnreadCount(null, "All")).toBe(3);
    store.currentUser = "bob";
    expect(await actions.getViewUnreadCount(null, "All")).toBe(1);
  });

  it("requires a session", async () => {
    store.currentUser = null;
    await expect(actions.getViewUnreadCount()).rejects.toThrow("Unauthorized");
  });
});
