import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory article table honouring the parts of `where` the state writes use.
type Row = { id: string; userId: string; isRead: boolean; readAt: Date | null; isStarred: boolean; isReadLater: boolean; readLaterSavedAt: Date | null };
const h = vi.hoisted(() => {
  const store = { rows: [] as Row[], user: "alice" as string | null };
  const matches = (row: Row, where: any) =>
    (where.userId === undefined || row.userId === where.userId) &&
    (!where.id?.in || where.id.in.includes(row.id)) &&
    (["isRead", "isStarred", "isReadLater"] as const).every((f) => where[f] === undefined || row[f] === where[f]);
  const db = {
    article: {
      findMany: vi.fn(async ({ where }: any) => store.rows.filter((r) => matches(r, where)).map((r) => ({ id: r.id }))),
      updateMany: vi.fn(({ where, data }: any) => ({ where, data })),
    },
    $transaction: vi.fn(async (ops: Array<{ where: any; data: any }>) => {
      return ops.map(({ where, data }) => {
        const hit = store.rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      });
    }),
  };
  return { store, db };
});
vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => (h.store.user ? { user: { id: h.store.user } } : null)) }));

import { MAX_STATE_OPS, applyArticleStateOps, groupStateOps, parseStateOps } from "../../server/articles/state";
import { applyArticleStateOps as action } from "../../app/actions/article-state";

const base = { isRead: false, readAt: null, isStarred: false, isReadLater: false, readLaterSavedAt: null };
beforeEach(() => {
  h.store.user = "alice";
  h.store.rows = [
    { id: "a1", userId: "alice", ...base },
    { id: "a2", userId: "alice", ...base, isRead: true, readAt: new Date(0) },
    { id: "b1", userId: "bob", ...base },
  ];
  vi.clearAllMocks();
});
const row = (id: string) => h.store.rows.find((r) => r.id === id)!;

describe("parseStateOps", () => {
  it("accepts 1..200 ops with at least one boolean field", () => {
    expect(parseStateOps([{ id: "a", isRead: true }]).ok).toBe(true);
    expect(parseStateOps(Array.from({ length: MAX_STATE_OPS }, (_, i) => ({ id: `a${i}`, isStarred: true }))).ok).toBe(true);
  });
  it.each([
    ["empty batch", []],
    ["too many ops", Array.from({ length: MAX_STATE_OPS + 1 }, (_, i) => ({ id: `a${i}`, isRead: true }))],
    ["no field", [{ id: "a" }]],
    ["unknown field", [{ id: "a", isRead: true, userId: "bob" }]],
    ["non-boolean", [{ id: "a", isRead: "yes" }]],
    ["oversized id", [{ id: "x".repeat(129), isRead: true }]],
    ["not an array", { id: "a", isRead: true }],
  ])("rejects %s", (_name, input) => {
    expect(parseStateOps(input).ok).toBe(false);
  });
});

describe("groupStateOps", () => {
  it("merges per article (later op wins) and groups by field + value", () => {
    const groups = groupStateOps([
      { id: "a", isRead: true },
      { id: "b", isRead: true, isStarred: true },
      { id: "a", isRead: false },
    ]);
    expect(Object.fromEntries(groups)).toEqual({ "isRead:false": ["a"], "isRead:true": ["b"], "isStarred:true": ["b"] });
  });
});

describe("applyArticleStateOps", () => {
  it("applies the user's own ops in one transaction and reports foreign / unknown ids as failed", async () => {
    const result = await applyArticleStateOps("alice", [
      { id: "a1", isRead: true, isReadLater: true },
      { id: "b1", isStarred: true },
      { id: "nope", isRead: true },
    ]);
    expect(result.failed.sort()).toEqual(["b1", "nope"]);
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    expect(row("a1")).toMatchObject({ isRead: true, isReadLater: true });
    expect(row("a1").readAt).toBeInstanceOf(Date);
    expect(row("a1").readLaterSavedAt).toBeInstanceOf(Date);
    expect(row("b1").isStarred).toBe(false);
  });

  it("is conditional on the current value, so repeating an op keeps readAt", async () => {
    const before = row("a2").readAt;
    await applyArticleStateOps("alice", [{ id: "a2", isRead: true }]);
    expect(row("a2").readAt).toBe(before);
    await applyArticleStateOps("alice", [{ id: "a2", isRead: false }]);
    expect(row("a2")).toMatchObject({ isRead: false, readAt: null });
  });
});

describe("applyArticleStateOps (server action)", () => {
  it("requires a session", async () => {
    h.store.user = null;
    await expect(action([{ id: "a1", isRead: true }])).rejects.toThrow("Unauthorized");
  });
  it("rejects invalid batches before touching the database", async () => {
    await expect(action([{ id: "a1" }])).rejects.toThrow(/Invalid ops/);
    expect(h.db.article.findMany).not.toHaveBeenCalled();
  });
  it("is scoped to the signed-in user", async () => {
    h.store.user = "bob";
    expect(await action([{ id: "a1", isStarred: true }])).toEqual({ failed: ["a1"] });
    expect(row("a1").isStarred).toBe(false);
  });
});
