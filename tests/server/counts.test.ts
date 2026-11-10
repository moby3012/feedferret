import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const calls: Record<string, any[]> = { groupBy: [], labelGroupBy: [], count: [] };
  const db = {
    user: { findUnique: vi.fn(async () => ({ hideDuplicates: true })) },
    feed: {
      findMany: vi.fn(async () => [
        { id: "f1", hideFromAllFeeds: false, category: null },
        { id: "f2", hideFromAllFeeds: true, category: null },
        { id: "f3", hideFromAllFeeds: false, category: { hideFromAllFeeds: true } },
      ]),
    },
    article: {
      groupBy: vi.fn(async (args: any) => {
        calls.groupBy.push(args);
        return [
          { feedId: "f1", _count: { _all: 3 } },
          { feedId: "f2", _count: { _all: 5 } },
          { feedId: "f3", _count: { _all: 7 } },
        ];
      }),
      count: vi.fn(async (args: any) => {
        calls.count.push(args);
        return args.where.isReadLater ? 2 : args.where.isStarred ? 4 : 1;
      }),
    },
    articleLabel: {
      groupBy: vi.fn(async (args: any) => {
        calls.labelGroupBy.push(args);
        return [{ labelId: "l1", _count: { _all: 9 } }];
      }),
    },
    notification: { count: vi.fn(async () => 6) },
  };
  return { db, calls };
});
vi.mock("@/lib/db", () => ({ db: h.db }));

import { getCounts } from "../../server/bootstrap";

beforeEach(() => {
  h.calls.groupBy = [];
  h.calls.labelGroupBy = [];
  h.calls.count = [];
});

describe("getCounts", () => {
  it("sums All-articles unread over visible feeds only and maps every count", async () => {
    expect(await getCounts("u1")).toEqual({
      unreadTotal: 3,
      byFeed: { f1: 3, f2: 5, f3: 7 },
      byLabel: { l1: 9 },
      later: 2,
      starred: 4,
      spoiler: 1,
      notifications: 6,
    });
  });

  it("uses the list visibility rules: user-scoped, unread, no spoilers, no hidden duplicates", async () => {
    await getCounts("u1");
    const where = h.calls.groupBy[0].where;
    expect(where).toMatchObject({ userId: "u1", isRead: false, isSpoiler: false, NOT: { isDuplicate: true, duplicateOf: { not: null } } });
    expect(h.calls.labelGroupBy[0].where).toMatchObject({ userId: "u1", article: { userId: "u1", isRead: false, isSpoiler: false } });
    const spoiler = h.calls.count.find((c) => c.where.isSpoiler === true);
    expect(spoiler.where.userId).toBe("u1");
  });
});
