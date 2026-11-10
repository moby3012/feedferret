import { describe, expect, it } from "vitest";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { markListsStale, removeLabelFromCachedArticles } from "../../features/articles/cache";
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
});
