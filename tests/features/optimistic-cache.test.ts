import { describe, expect, it } from "vitest";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  adjustCounts,
  adjustLabelCounts,
  applyArticlePatch,
  findCachedArticle,
  pruneReadRows,
  rollbackFailedOps,
} from "../../features/articles/cache";
import { listKeyOf } from "../../features/articles/scope";
import { StateBatcher } from "../../features/articles/state-batcher";
import type { ArticleListItem, ArticlePage } from "../../features/articles/types";
import type { Counts } from "../../features/bootstrap/types";

const row = (id: string, extra: Partial<ArticleListItem> = {}) =>
  ({ id, feedId: "f1", isRead: false, isStarred: false, isReadLater: false, isSpoiler: false, labelIds: [], ...extra }) as unknown as ArticleListItem;
const page = (...items: ArticleListItem[]): InfiniteData<ArticlePage, string | null> => ({ pages: [{ items, nextCursor: null }], pageParams: [null] });
const counts = (extra: Partial<Counts> = {}): Counts => ({
  unreadTotal: 10,
  byFeed: { f1: 6, f2: 4 },
  byLabel: { l1: 2 },
  later: 1,
  starred: 1,
  spoiler: 0,
  notifications: 0,
  ...extra,
});

const ALL = ["list", "all", "unread", "new"];
const FEED = ["list", "feed:f1", "unread", "new"];
const STARRED = ["list", "v:starred", "all", "new"];

function client() {
  const qc = new QueryClient();
  qc.setQueryData(ALL, page(row("a", { labelIds: ["l1"] }), row("b")));
  qc.setQueryData(FEED, page(row("a", { labelIds: ["l1"] })));
  qc.setQueryData(["article", "a"], { ...row("a", { labelIds: ["l1"] }), html: "<p>x</p>" });
  qc.setQueryData(["counts"], counts());
  qc.setQueryData(["feeds"], [
    { id: "f1", hideFromAllFeeds: false, category: null },
    { id: "f2", hideFromAllFeeds: false, category: { hideFromAllFeeds: true } },
  ]);
  return qc;
}
const listRow = (qc: QueryClient, key: unknown[], id: string) =>
  qc.getQueryData<InfiniteData<ArticlePage>>(key)!.pages.flatMap((p) => p.items).find((i) => i.id === id);

describe("applyArticlePatch", () => {
  it("patches every list copy and the detail, and moves feed / label / total counts", () => {
    const qc = client();
    const result = applyArticlePatch(qc, "a", { isRead: true });
    expect(result?.changed).toEqual({ isRead: true });
    expect(listRow(qc, ALL, "a")!.isRead).toBe(true);
    expect(listRow(qc, FEED, "a")!.isRead).toBe(true);
    expect(qc.getQueryData<ArticleListItem>(["article", "a"])!.isRead).toBe(true);
    expect(qc.getQueryData<Counts>(["counts"])).toMatchObject({ unreadTotal: 9, byFeed: { f1: 5 }, byLabel: { l1: 1 } });
    // Untouched rows keep their identity (no re-render of other rows).
    expect(listRow(qc, ALL, "b")).toBe(qc.getQueryData<InfiniteData<ArticlePage>>(ALL)!.pages[0].items[1]);
  });

  it("is idempotent: the same value again changes nothing (and returns null)", () => {
    const qc = client();
    applyArticlePatch(qc, "a", { isStarred: true });
    const before = qc.getQueryData(["counts"]);
    expect(applyArticlePatch(qc, "a", { isStarred: true })).toBeNull();
    expect(qc.getQueryData(["counts"])).toBe(before);
    expect(qc.getQueryData<Counts>(["counts"])!.starred).toBe(2);
  });

  it("keeps rows in the list (snapshot) and stale-marks only the membership list", () => {
    const qc = client();
    applyArticlePatch(qc, "a", { isStarred: true });
    qc.setQueryData(STARRED, page(row("a", { isStarred: true })));
    applyArticlePatch(qc, "a", { isStarred: false });
    expect(listRow(qc, STARRED, "a")).toMatchObject({ isStarred: false });
    expect(qc.getQueryCache().find({ queryKey: STARRED })!.state.isInvalidated).toBe(true);
    expect(qc.getQueryCache().find({ queryKey: ALL })!.state.isInvalidated).toBe(false);
  });

  it("does not restart the snapshot's staleness clock or clear a stale mark", () => {
    const qc = client();
    const query = qc.getQueryCache().find({ queryKey: FEED })!;
    qc.setQueryData(FEED, query.state.data, { updatedAt: 1000 });
    void qc.invalidateQueries({ queryKey: FEED, refetchType: "none" });
    applyArticlePatch(qc, "a", { isReadLater: true });
    expect(query.state.dataUpdatedAt).toBe(1000);
    expect(query.state.isInvalidated).toBe(true);
  });
});

describe("adjustCounts", () => {
  it("skips unreadTotal for feeds hidden from All articles, but moves the feed", () => {
    const next = adjustCounts(counts(), row("x", { feedId: "f2" }), { isRead: true }, true);
    expect(next.unreadTotal).toBe(10);
    expect(next.byFeed.f2).toBe(3);
  });

  it("spoilers never move counts; star / later move their totals; never below 0", () => {
    expect(adjustCounts(counts(), row("x", { isSpoiler: true }), { isRead: true, isStarred: true }, false)).toEqual(counts());
    const next = adjustCounts(counts({ later: 0 }), row("x", { isReadLater: true }), { isReadLater: false, isStarred: true }, false);
    expect(next).toMatchObject({ later: 0, starred: 2 });
  });

  it("label changes move byLabel only for unread rows", () => {
    expect(adjustLabelCounts(counts(), row("x", { labelIds: ["l1"] }), ["l2"]).byLabel).toEqual({ l1: 1, l2: 1 });
    expect(adjustLabelCounts(counts(), row("x", { labelIds: ["l1"], isRead: true }), ["l2"]).byLabel).toEqual({ l1: 2 });
  });
});

describe("rollbackFailedOps (inverse patch per field)", () => {
  it("reverts exactly the failed field, including its counts", () => {
    const qc = client();
    applyArticlePatch(qc, "a", { isRead: true });
    applyArticlePatch(qc, "a", { isStarred: true });
    const reverted = rollbackFailedOps(qc, [{ id: "a", field: "isStarred", value: true }], () => false);
    expect(reverted).toHaveLength(1);
    expect(findCachedArticle(qc, "a")).toMatchObject({ isRead: true, isStarred: false });
    expect(qc.getQueryData<Counts>(["counts"])).toMatchObject({ starred: 1, unreadTotal: 9 });
  });

  it("leaves the field alone when a newer write changed it or is still queued", () => {
    const qc = client();
    applyArticlePatch(qc, "a", { isStarred: true });
    applyArticlePatch(qc, "a", { isStarred: false }); // user flipped back after the failed write was sent
    expect(rollbackFailedOps(qc, [{ id: "a", field: "isStarred", value: true }], () => false)).toHaveLength(0);
    applyArticlePatch(qc, "a", { isStarred: true });
    expect(rollbackFailedOps(qc, [{ id: "a", field: "isStarred", value: true }], () => true)).toHaveLength(0);
    expect(findCachedArticle(qc, "a")!.isStarred).toBe(true);
  });

  it("overlapping writes: a failed flush only reverts what the server never got", async () => {
    const qc = client();
    let n = 0;
    const batcher = new StateBatcher({
      send: () => (n++ === 0 ? Promise.reject(new Error("500")) : Promise.resolve({ failed: [] })),
      onSettled: ({ failed }) => rollbackFailedOps(qc, failed, (id, f) => batcher.hasPending(id, f)),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    const toggle = (id: string, field: "isRead" | "isStarred", value: boolean) => {
      const r = applyArticlePatch(qc, id, { [field]: value });
      if (r) batcher.enqueue({ id, field, value }, r.before[field]);
    };
    toggle("a", "isRead", true);
    toggle("b", "isStarred", true);
    batcher.flush(); // in flight, will fail
    toggle("b", "isStarred", false); // overlapping write of a field in the failing flush
    batcher.flush(); // goes out right after the failing call settles
    await batcher.whenIdle();
    expect(findCachedArticle(qc, "a")!.isRead).toBe(false); // reverted
    expect(findCachedArticle(qc, "b")!.isStarred).toBe(false); // user's latest value, not touched
    expect(qc.getQueryData<Counts>(["counts"])).toEqual(counts());
  });
});

describe("pruneReadRows (prune on rebind)", () => {
  it("drops read rows from an unread snapshot, never from show=all", () => {
    const qc = client();
    const unread = listKeyOf({ kind: "all" }, "unread", "new");
    const all = listKeyOf({ kind: "all" }, "all", "new");
    qc.setQueryData(["list", "all", "all", "new"], page(row("a", { isRead: true }), row("b")));
    applyArticlePatch(qc, "a", { isRead: true });
    pruneReadRows(qc, unread);
    pruneReadRows(qc, all);
    expect(qc.getQueryData<InfiniteData<ArticlePage>>(ALL)!.pages[0].items.map((i) => i.id)).toEqual(["b"]);
    expect(qc.getQueryData<InfiniteData<ArticlePage>>(["list", "all", "all", "new"])!.pages[0].items).toHaveLength(2);
  });
});
