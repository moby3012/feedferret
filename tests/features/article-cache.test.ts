import { describe, expect, it } from "vitest";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { markListsStale, mergeRetainedRows, removeLabelFromCachedArticles } from "../../features/articles/cache";
import type { ArticleListItem, ArticlePage } from "../../features/articles/types";

const row = (id: string, extra: Partial<ArticleListItem> = {}) => ({ id, isRead: false, labelIds: [], ...extra }) as unknown as ArticleListItem;
const data = (...pages: string[][]): InfiniteData<ArticlePage, string | null> => ({
  pages: pages.map((ids, i) => ({ items: ids.map((id) => row(id)), nextCursor: i < pages.length - 1 ? `c${i}` : null })),
  pageParams: pages.map((_, i) => (i === 0 ? null : `c${i - 1}`)),
});
const ids = (d: InfiniteData<ArticlePage, string | null>) => d.pages.map((p) => p.items.map((i) => i.id));

describe("mergeRetainedRows", () => {
  it("puts retained rows a refetch dropped back after their previous neighbour, cursors untouched", () => {
    const previous = data(["a", "b", "c"], ["d", "e", "f"]);
    const next = data(["a", "d", "e"], ["f", "g", "h"]); // b, c, read → filtered by the server
    const merged = mergeRetainedRows(previous, next, new Set(["b", "c"]));
    expect(ids(merged)).toEqual([["a", "b", "c", "d", "e"], ["f", "g", "h"]]);
    expect(merged.pages.map((p) => p.nextCursor)).toEqual(["c0", null]);
    expect(merged.pageParams).toEqual(next.pageParams);
  });

  it("a retained first row goes back to the top; rows on later pages stay on their page", () => {
    const previous = data(["a", "b"], ["c", "d"]);
    const next = data(["b", "d"], ["e"]);
    expect(ids(mergeRetainedRows(previous, next, new Set(["a", "c"])))).toEqual([["a", "b", "c", "d"], ["e"]]);
  });

  it("returns `next` itself when nothing is missing, nothing is retained or there is no previous data", () => {
    const next = data(["a", "b"]);
    expect(mergeRetainedRows(data(["a", "b"]), next, new Set(["a"]))).toBe(next);
    expect(mergeRetainedRows(data(["x", "a"]), next, new Set())).toBe(next);
    expect(mergeRetainedRows(undefined, next, new Set(["a"]))).toBe(next);
    // Not retained → dropped as the server says.
    expect(ids(mergeRetainedRows(data(["x", "a", "b"]), next, new Set(["y"])))).toEqual([["a", "b"]]);
  });
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
