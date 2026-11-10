import { describe, expect, it } from "vitest";
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from "@tanstack/react-query";
import { markListsStale, patchCachedArticle, removeLabelFromCachedArticles } from "../../features/articles/cache";
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
});
