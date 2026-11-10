import { describe, expect, it } from "vitest";
import { QueryClient, dehydrate, type InfiniteData } from "@tanstack/react-query";
import { applyArticlePatch } from "../../features/articles/cache";
import { registerStateBatcher } from "../../features/articles/batcher-registry";
import { StateBatcher } from "../../features/articles/state-batcher";
import type { ArticleListItem, ArticlePage } from "../../features/articles/types";
import type { Counts } from "../../features/bootstrap/types";
import { hydrateMissing } from "../../features/bootstrap/hydrate-missing";

const row = (id: string, extra: Partial<ArticleListItem> = {}) =>
  ({ id, feedId: "f1", isRead: false, isStarred: false, isReadLater: false, isSpoiler: false, labelIds: [], ...extra }) as unknown as ArticleListItem;
const page = (...items: ArticleListItem[]): InfiniteData<ArticlePage, string | null> => ({ pages: [{ items, nextCursor: null }], pageParams: [null] });
const counts = (unread: number): Counts => ({ unreadTotal: unread, byFeed: { f1: unread }, byLabel: {}, later: 0, starred: 0, spoiler: 0, notifications: 0 });

const ALL = ["list", "all", "unread", "new"];
const FEED = ["list", "feed:f1", "unread", "new"];

/** What the server would send with a `router.refresh()` that lost its Fetch Metadata. */
function serverSnapshot() {
  const server = new QueryClient();
  server.setQueryData(ALL, page(row("a"), row("b")));
  server.setQueryData(FEED, page(row("a")));
  server.setQueryData(["article", "a"], { ...row("a"), html: "<p>x</p>" });
  server.setQueryData(["counts"], counts(2));
  return dehydrate(server);
}

/** A client that marked `a` read: optimistic patch applied, write still queued in the batcher. */
function clientWithPendingWrite() {
  const qc = new QueryClient();
  qc.setQueryData(ALL, page(row("a"), row("b")));
  qc.setQueryData(["counts"], counts(2));
  const batcher = new StateBatcher({ send: () => new Promise(() => {}), setTimer: () => 0, clearTimer: () => {} });
  registerStateBatcher(qc, batcher);
  applyArticlePatch(qc, "a", { isRead: true });
  batcher.enqueue({ id: "a", field: "isRead", value: true }, false);
  return qc;
}

const isRead = (qc: QueryClient, key: unknown[], id: string) =>
  qc.getQueryData<InfiniteData<ArticlePage>>(key)!.pages.flatMap((p) => p.items).find((i) => i.id === id)!.isRead;

describe("hydrateMissing (cold-start snapshot never clobbers client state)", () => {
  it("fills an empty cache completely (document load)", () => {
    const qc = new QueryClient();
    const state = serverSnapshot();
    expect(hydrateMissing(qc, state).sort()).toEqual(state.queries.map((q) => q.queryHash).sort());
    expect(qc.getQueryData<Counts>(["counts"])!.unreadTotal).toBe(2);
  });

  it("refresh during an uncommitted batcher write: existing keys keep the optimistic state", () => {
    const qc = clientWithPendingWrite();
    const listBefore = qc.getQueryData(ALL);
    const countsBefore = qc.getQueryData(["counts"]);
    const hydrated = hydrateMissing(qc, serverSnapshot());

    // The list and the counts the client had are untouched (same objects).
    expect(qc.getQueryData(ALL)).toBe(listBefore);
    expect(qc.getQueryData(["counts"])).toBe(countsBefore);
    expect(isRead(qc, ALL, "a")).toBe(true);
    expect(qc.getQueryData<Counts>(["counts"])!.unreadTotal).toBe(1);
    expect(hydrated).not.toContain(JSON.stringify(ALL));
    expect(hydrated).not.toContain(JSON.stringify(["counts"]));
  });

  it("keys the client lacks are hydrated with the pending writes overlaid", () => {
    const qc = clientWithPendingWrite();
    const hydrated = hydrateMissing(qc, serverSnapshot());
    expect(hydrated).toEqual(expect.arrayContaining([JSON.stringify(FEED), JSON.stringify(["article", "a"])]));
    expect(isRead(qc, FEED, "a")).toBe(true);
    expect(qc.getQueryData<ArticleListItem>(["article", "a"])!.isRead).toBe(true);
  });

  it("an existing entry is skipped even when the snapshot is newer", () => {
    const qc = new QueryClient();
    qc.setQueryData(["counts"], counts(7), { updatedAt: 1 });
    hydrateMissing(qc, serverSnapshot());
    expect(qc.getQueryData<Counts>(["counts"])!.unreadTotal).toBe(7);
  });

  it("no snapshot (router fetch with Fetch Metadata) is a no-op", () => {
    const qc = new QueryClient();
    expect(hydrateMissing(qc, undefined)).toEqual([]);
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });
});
