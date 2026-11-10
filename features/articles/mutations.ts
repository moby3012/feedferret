"use client";

import { createContext, createElement, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useIsMutating, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { applyArticleStateOps } from "@/app/actions/article-state";
import { fetchFullText as fetchFullTextAction, markAllAsRead, markArticlesAsUnread, setArticleLabels, updateFeed } from "@/app/actions/feeds";
import { adjustCounts, adjustLabelCounts, applyArticlePatch, findCachedArticle, invalidateCounts, isHiddenFromAll, patchCachedArticle, patchCachedArticles, rollbackFailedOps } from "./cache";
import { qk } from "./keys";
import { registerStateBatcher, unregisterStateBatcher } from "./batcher-registry";
import { StateBatcher, type SettledFlush, type StateField } from "./state-batcher";
import type { ArticleListItem, ArticlePage } from "./types";
import type { Counts } from "@/features/bootstrap/types";
import { isOnline } from "@/features/bootstrap/online";

// The ONE write surface for article state (.pm/spec-shell-design.md §2.4).
// Every component (list rows, reader, sidebar menus, palette, shortcuts) goes
// through `useArticleActions()`; the TanStack cache is the only owner of the
// fields, the batcher the only path to the server for hot toggles.

export type ToggleSource = "tap" | "swipe" | "key" | "auto" | "scroll";

/** `categoryId`: the category a by-name selection resolved to (names are not unique). */
export type MarkViewScope = { feedId?: string | null; category?: string | null; categoryId?: string | null; search?: string | null };

export interface ArticleActions {
  setRead(id: string, read: boolean, src?: ToggleSource): void;
  toggleRead(id: string): void;
  toggleStar(id: string): void;
  toggleLater(id: string): void;
  setLabels(id: string, labelIds: string[]): void;
  fetchFullText(id: string): void;
  /** Bulk mark-read of a whole view with the 6 s Undo toast (server-issued undo token). */
  markViewRead(scope: MarkViewScope): void;
}

const MARK_VIEW_READ_KEY = ["mark-view-read"] as const;
const FULL_TEXT_KEY = ["fetch-full-text"] as const;
const FAILURE_TOAST_ID = "article-state-failed";
const OFFLINE_TOAST_ID = "article-state-offline";

const ArticleActionsContext = createContext<ArticleActions | null>(null);

type ListData = { pages: ArticlePage[] };

/** First cached copy of each of `ids` (one pass over the list caches). */
function cachedArticles(qc: QueryClient, ids: ReadonlySet<string>): Map<string, ArticleListItem> {
  const out = new Map<string, ArticleListItem>();
  for (const id of ids) {
    const detail = qc.getQueryData<ArticleListItem>(qk.article(id));
    if (detail) out.set(id, detail);
  }
  for (const [, data] of qc.getQueriesData<ListData>({ queryKey: qk.lists })) {
    if (!data || !Array.isArray(data.pages)) continue;
    for (const page of data.pages) for (const item of page.items) if (ids.has(item.id) && !out.has(item.id)) out.set(item.id, item);
  }
  return out;
}

/** Patches `ids` read/unread in every cache and moves the counts for the rows the cache knows. */
function applyBulkRead(qc: QueryClient, ids: string[], isRead: boolean) {
  if (ids.length === 0) return;
  const known = cachedArticles(qc, new Set(ids));
  void qc.cancelQueries({ queryKey: qk.counts });
  qc.setQueryData<Counts>(qk.counts, (counts) => {
    if (!counts) return counts;
    let next = counts;
    for (const item of known.values()) next = adjustCounts(next, item, { isRead }, isHiddenFromAll(qc, item.feedId));
    return next;
  });
  patchCachedArticles(qc, ids, { isRead });
  qc.invalidateQueries({ queryKey: qk.listScope("v:recent"), refetchType: "none" });
}

export function ArticleActionsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const t = useTranslations("articleState");
  const tSidebar = useTranslations("sidebar");
  const tReader = useTranslations("articleReader");
  const tRef = useRef({ t, tSidebar, tReader });
  useEffect(() => {
    tRef.current = { t, tSidebar, tReader };
  }, [t, tSidebar, tReader]);

  const batcher = useMemo(() => {
    const onSettled = ({ failed }: SettledFlush) => {
      if (failed.length === 0) return;
      rollbackFailedOps(qc, failed, (id, field) => instance.hasPending(id, field));
      toast.error(tRef.current.t("toggleFailed"), { id: FAILURE_TOAST_ID });
    };
    const instance = new StateBatcher({ send: (ops) => applyArticleStateOps(ops), onSettled });
    return instance;
  }, [qc]);

  useEffect(() => {
    registerStateBatcher(qc, batcher);
    // Leaving the page (tab switch, app to background, close): send now.
    const onHidden = () => {
      if (document.visibilityState === "hidden") batcher.flush();
    };
    const onPageHide = () => batcher.flush();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
      batcher.flush();
      unregisterStateBatcher(qc, batcher);
    };
  }, [qc, batcher]);

  const { mutate: undoMutate } = useMutation({
    mutationFn: (undoToken: string) => markArticlesAsUnread(undoToken),
    onSuccess: (result) => {
      applyBulkRead(qc, result.ids, false);
      invalidateCounts(qc);
    },
    onError: () => {
      toast.error(tRef.current.tSidebar("undoFailed"));
      invalidateCounts(qc);
    },
  });

  const { mutate: markAllMutate } = useMutation({
    mutationKey: MARK_VIEW_READ_KEY,
    mutationFn: (scope: MarkViewScope) => markAllAsRead(scope),
    onSuccess: (result) => {
      const ids = result?.ids ?? [];
      if (ids.length === 0) return;
      applyBulkRead(qc, ids, true);
      // Rows the cache does not hold moved counts too: one reconcile request.
      invalidateCounts(qc);
      const undoToken = result.undoToken;
      toast(tRef.current.tSidebar("undoMarkAllReadMessage", { count: ids.length }), {
        duration: 6000,
        action: undoToken ? { label: tRef.current.tSidebar("undo"), onClick: () => undoMutate(undoToken) } : undefined,
      });
    },
    onError: () => {
      // Nothing was changed (the server update is atomic).
      toast.error(tRef.current.tSidebar("markAllReadFailed"));
    },
  });

  const { mutate: fullTextMutate } = useMutation({
    mutationKey: FULL_TEXT_KEY,
    mutationFn: (id: string) => fetchFullTextAction(id),
    onSuccess: (article) => {
      // The body lives in the detail entry: refetch it (render-ready HTML from the server).
      if (typeof article?.excerpt === "string") patchCachedArticle(qc, article.id, { excerpt: article.excerpt });
      qc.invalidateQueries({ queryKey: qk.article(article.id) });
      const { tReader: tr } = tRef.current;
      toast.success(tr("fullTextLoaded"));
      const suggestion = article.suggestAutoFullText;
      if (suggestion) {
        const update = (data: Parameters<typeof updateFeed>[1]) =>
          updateFeed(suggestion.feedId, data).then(() => qc.invalidateQueries({ queryKey: qk.feeds }));
        toast(tr("truncatedFeedSuggestion"), {
          description: suggestion.feedName,
          action: { label: tr("enableAutoFullText"), onClick: () => void update({ fullTextMode: "auto" }) },
          cancel: { label: tr("dontAskAgainFullText"), onClick: () => void update({ fullTextAutoSuggestDismissed: true }) },
          duration: 10000,
        });
      }
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : tRef.current.tReader("fullTextUnavailable"));
    },
  });

  const actions = useMemo<ArticleActions>(() => {
    const guardOffline = () => {
      if (isOnline()) return false;
      toast.error(tRef.current.t("offlineReadOnly"), { id: OFFLINE_TOAST_ID });
      return true;
    };
    const set = (id: string, field: StateField, value: boolean) => {
      if (guardOffline()) return;
      const result = applyArticlePatch(qc, id, { [field]: value });
      if (!result) return;
      batcher.enqueue({ id, field, value }, result.before[field]);
    };
    const toggle = (id: string, field: StateField) => {
      const current = findCachedArticle(qc, id);
      if (current) set(id, field, !current[field]);
    };

    return {
      setRead: (id, read) => set(id, "isRead", read),
      toggleRead: (id) => toggle(id, "isRead"),
      toggleStar: (id) => toggle(id, "isStarred"),
      toggleLater: (id) => toggle(id, "isReadLater"),

      setLabels: (id, labelIds) => {
        if (guardOffline()) return;
        const before = findCachedArticle(qc, id);
        if (!before) return;
        const next = [...new Set(labelIds)];
        void qc.cancelQueries({ queryKey: qk.counts });
        qc.setQueryData<Counts>(qk.counts, (c) => (c ? adjustLabelCounts(c, before, next) : c));
        patchCachedArticle(qc, id, { labelIds: next });
        const touched = new Set([...before.labelIds, ...next]);
        for (const labelId of touched) qc.invalidateQueries({ queryKey: qk.listScope(`label:${labelId}`), refetchType: "none" });
        setArticleLabels(id, next)
          .then((article) => {
            const saved = (article?.labels ?? []).map((l: { labelId: string }) => l.labelId);
            const current = findCachedArticle(qc, id);
            if (current && current.labelIds.join() === next.join() && saved.join() !== next.join()) {
              // The server dropped ids (deleted / foreign labels): take its answer.
              qc.setQueryData<Counts>(qk.counts, (c) => (c ? adjustLabelCounts(c, current, saved) : c));
              patchCachedArticle(qc, id, { labelIds: saved });
            }
          })
          .catch(() => {
            const current = findCachedArticle(qc, id);
            if (current && current.labelIds.join() === next.join()) {
              qc.setQueryData<Counts>(qk.counts, (c) => (c ? adjustLabelCounts(c, current, before.labelIds) : c));
              patchCachedArticle(qc, id, { labelIds: before.labelIds });
            }
            toast.error(tRef.current.t("labelsFailed"));
          });
      },

      fetchFullText: (id) => fullTextMutate(id),

      markViewRead: (scope) => {
        if (guardOffline()) return;
        markAllMutate(scope);
      },
    };
  }, [qc, batcher, markAllMutate, fullTextMutate]);

  return createElement(ArticleActionsContext.Provider, { value: actions }, children);
}

export function useArticleActions(): ArticleActions {
  const actions = useContext(ArticleActionsContext);
  if (!actions) throw new Error("useArticleActions() outside <ArticleActionsProvider>");
  return actions;
}

/** A bulk mark-read is in flight (end-of-list card spinner). */
export function useIsMarkingViewRead(): boolean {
  return useIsMutating({ mutationKey: MARK_VIEW_READ_KEY }) > 0;
}

/** A full-text fetch is in flight (reader button spinner). */
export function useIsFetchingFullText(): boolean {
  return useIsMutating({ mutationKey: FULL_TEXT_KEY }) > 0;
}
