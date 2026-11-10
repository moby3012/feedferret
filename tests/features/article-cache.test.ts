import { describe, expect, it } from "vitest";
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from "@tanstack/react-query";
import { applyArticlePatch, markListsStale, patchCachedArticle, removeLabelFromCachedArticles, rollbackFailedOps } from "../../features/articles/cache";
import type { ArticleListItem, ArticlePage } from "../../features/articles/types";

const row = (id: string, extra: Partial<ArticleListItem> = {}) => ({ id, isRead: false, labelIds: [], ...extra }) as unknown as ArticleListItem;
const data = (...pages: string[][]): InfiniteData<ArticlePage, string | null> => ({
  pages: pages.map((ids, i) => ({ items: ids.map((id) => row(id)), nextCursor: i < pages.length - 1 ? `c${i}` : null })),
  pageParams: pages.map((_, i) => (i === 0 ? null : `c${i - 1}`)),
});

describe("list cache helpers", () => {
  it("markListsStale marks lists stale without refetching them", () => {
    const qc = new QueryClient();
    qc.setQueryData(["list", "all", "unread", "new"], data(["a"]));
    markListsStale(qc);
    const query = qc.getQueryCache().find({ queryKey: ["list", "all", "unread", "new"] })!;
    expect(query.state.isInvalidated).toBe(true);
    expect(query.state.fetchStatus).toBe("idle");
  });

  it("removeLabelFromCachedArticles strips a deleted label from list rows and details", () => {
    const qc = new QueryClient();
    qc.setQueryData(["list", "all", "unread", "new"], { pages: [{ items: [row("a", { labelIds: ["l1", "l2"] }), row("b")], nextCursor: null }], pageParams: [null] });
    qc.setQueryData(["article", "a"], { ...row("a", { labelIds: ["l1"] }), html: "" });
    removeLabelFromCachedArticles(qc, "l1");
    const list = qc.getQueryData<InfiniteData<ArticlePage>>(["list", "all", "unread", "new"])!;
    expect(list.pages[0].items.map((i) => i.labelIds)).toEqual([["l2"], []]);
    expect(qc.getQueryData<ArticleListItem>(["article", "a"])!.labelIds).toEqual([]);
  });

  it("a row patched while the next page is on the wire keeps its patch (fetchNextPage builds on the pages it started with)", async () => {
    const qc = new QueryClient();
    const key = ["list", "all", "unread", "new"];
    let release!: () => void;
    const observer = new InfiniteQueryObserver(qc, {
      queryKey: key,
      initialPageParam: null as string | null,
      getNextPageParam: (last: ArticlePage) => last.nextCursor,
      queryFn: async ({ pageParam }) => {
        if (pageParam === null) return { items: [row("a"), row("b")], nextCursor: "c0" } as unknown as ArticlePage;
        await new Promise<void>((r) => (release = r));
        return { items: [row("c")], nextCursor: null } as unknown as ArticlePage;
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    const more = observer.fetchNextPage();
    await Promise.resolve();
    expect(qc.getQueryCache().find({ queryKey: key })!.state.fetchStatus).toBe("fetching");
    patchCachedArticle(qc, "a", { isRead: true });
    release();
    await more;
    const list = qc.getQueryData<InfiniteData<ArticlePage>>(key)!;
    expect(list.pages.flatMap((p) => p.items.map((i) => [i.id, i.isRead]))).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
    unsubscribe();
  });

  /**
   * A list paging in `c` while `c` is patched. `c` is not in the list's current
   * rows — the cache knows it only from its detail entry (the reader) — so the
   * live rewrite changes nothing there; the replay must still be queued.
   */
  async function pagingWithForeignRow(cachedRead: boolean, serverRead: boolean) {
    const qc = new QueryClient();
    const key = ["list", "all", "all", "new"];
    qc.setQueryData(["article", "c"], { ...row("c", { isRead: cachedRead }), feedId: "f", html: "" });
    let release!: () => void;
    const observer = new InfiniteQueryObserver(qc, {
      queryKey: key,
      initialPageParam: null as string | null,
      getNextPageParam: (last: ArticlePage) => last.nextCursor,
      queryFn: async ({ pageParam }) => {
        if (pageParam === null) return { items: [row("a"), row("b")], nextCursor: "c0" } as unknown as ArticlePage;
        await new Promise<void>((r) => (release = r));
        return { items: [row("c", { isRead: serverRead })], nextCursor: null } as unknown as ArticlePage;
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    const more = observer.fetchNextPage();
    await Promise.resolve();
    expect(qc.getQueryCache().find({ queryKey: key })!.state.fetchStatus).toBe("fetching");
    const settle = async () => {
      release();
      await more;
      unsubscribe();
      const list = qc.getQueryData<InfiniteData<ArticlePage>>(key)!;
      return list.pages.flatMap((p) => p.items).find((i) => i.id === "c")!.isRead;
    };
    return { qc, settle };
  }

  it("a patch to an article the fetching list does not hold yet is replayed onto the page that brings it", async () => {
    const { qc, settle } = await pagingWithForeignRow(false, false);
    expect(applyArticlePatch(qc, "c", { isRead: true })).not.toBeNull();
    expect(await settle()).toBe(true);
  });

  it("inverse toggles during the fetch replay in order (last one wins)", async () => {
    const { qc, settle } = await pagingWithForeignRow(false, true); // the page was read after the first toggle hit the server
    applyArticlePatch(qc, "c", { isRead: true });
    applyArticlePatch(qc, "c", { isRead: false });
    expect(await settle()).toBe(false);
  });

  it("a rollback during the fetch is replayed after the optimistic patch", async () => {
    // Server page says unread; the cache had it read, the user marked it unread
    // and that write failed: the rollback (back to read) must win.
    const { qc, settle } = await pagingWithForeignRow(true, false);
    applyArticlePatch(qc, "c", { isRead: false });
    const reverted = rollbackFailedOps(qc, [{ id: "c", field: "isRead", value: false } as never], () => false);
    expect(reverted).toHaveLength(1);
    expect(await settle()).toBe(true);
  });
});
