import { describe, it, expect, vi, beforeEach } from "vitest";
import * as actions from "../../app/actions/feeds";

// In-memory notification + feed tables honouring the `where` the actions use,
// so scoping is tested by behaviour.
type Notif = { id: string; userId: string; type: string };
type FeedRow = { id: string; userId: string; autoMuted: boolean; consecutiveFailureCount: number };

const h = vi.hoisted(() => {
  const store = {
    notifications: [] as Notif[],
    feeds: [] as FeedRow[],
    currentUser: "alice" as string | null,
  };
  const dbMock = {
    notification: {
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = store.notifications.length;
        store.notifications = store.notifications.filter((n) => !((where.id === undefined || n.id === where.id) && n.userId === where.userId));
        return { count: before - store.notifications.length };
      }),
    },
    feed: { updateMany: vi.fn(), update: vi.fn() },
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
vi.mock("@/lib/rss-sync", () => ({}));
vi.mock("@/lib/feed-fetcher", () => ({}));
vi.mock("@/lib/ssrf", () => ({}));
vi.mock("@/lib/feed-extraction", () => ({}));
vi.mock("@/lib/page-feed-suggest", () => ({}));
vi.mock("@/lib/page-feed-create", () => ({}));

beforeEach(() => {
  store.currentUser = "alice";
  store.notifications = [
    { id: "n1", userId: "alice", type: "feed_auto_muted" },
    { id: "n2", userId: "alice", type: "keyword_alert" },
    { id: "n3", userId: "bob", type: "feed_auto_muted" },
  ];
  store.feeds = [{ id: "f1", userId: "alice", autoMuted: true, consecutiveFailureCount: 10 }];
  vi.clearAllMocks();
});

describe("clearAllNotifications", () => {
  it("deletes only the session user's notifications", async () => {
    const res = await actions.clearAllNotifications();
    expect(res.deleted).toBe(2);
    expect(store.notifications.map((n) => n.id)).toEqual(["n3"]);
  });

  it("never touches feed mute / error state", async () => {
    await actions.clearAllNotifications();
    expect(dbMock.feed.updateMany).not.toHaveBeenCalled();
    expect(dbMock.feed.update).not.toHaveBeenCalled();
    expect(store.feeds[0]).toMatchObject({ autoMuted: true, consecutiveFailureCount: 10 });
  });

  it("rejects an anonymous caller", async () => {
    store.currentUser = null;
    await expect(actions.clearAllNotifications()).rejects.toThrow("Unauthorized");
    expect(store.notifications).toHaveLength(3);
  });
});

describe("dismissNotification", () => {
  it("deletes one own notification", async () => {
    expect(await actions.dismissNotification("n1")).toEqual({ deleted: 1 });
    expect(store.notifications.map((n) => n.id)).toEqual(["n2", "n3"]);
  });

  it("cannot delete another user's notification", async () => {
    expect(await actions.dismissNotification("n3")).toEqual({ deleted: 0 });
    expect(store.notifications).toHaveLength(3);
  });

  it("rejects anonymous callers and bad ids", async () => {
    await expect(actions.dismissNotification("")).rejects.toThrow();
    // @ts-expect-error — wrong runtime type must not reach Prisma
    await expect(actions.dismissNotification({ not: "a string" })).rejects.toThrow();
    store.currentUser = null;
    await expect(actions.dismissNotification("n1")).rejects.toThrow("Unauthorized");
    expect(store.notifications).toHaveLength(3);
  });
});
