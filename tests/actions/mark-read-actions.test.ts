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
    $queryRaw: vi.fn(),
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

// markAllAsRead / Undo themselves run against a real SQLite DB (raw chunked
// UPDATE … RETURNING): tests/actions/mark-all-read.sqlite.test.ts.

describe("markArticlesAsUnread (undo via server-side token)", () => {
  it("rejects malformed / unknown tokens without touching the database", async () => {
    for (const bad of ["", "a1", "x".repeat(500), "../../etc/passwd", ["a1"] as unknown as string, undefined as unknown as string]) {
      await expect(actions.markArticlesAsUnread(bad)).rejects.toThrow("Undo expired");
    }
    expect(dbMock.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.article.updateMany).not.toHaveBeenCalled();
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
