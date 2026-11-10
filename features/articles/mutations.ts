"use client";

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useIsMutating, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { applyArticleStateOps, markArticleIdsRead, markListRangeRead } from "@/app/actions/article-state";
import { fetchFullText as fetchFullTextAction, markAllAsRead, markArticlesAsUnread, setArticleLabels, updateFeed } from "@/app/actions/feeds";
import { adjustCounts, adjustLabelCounts, applyArticlePatch, findCachedArticle, invalidateCounts, isHiddenFromAll, patchCachedArticle, patchCachedArticles, rollbackFailedOps } from "./cache";
import { qk } from "./keys";
import { registerStateBatcher, unregisterStateBatcher } from "./batcher-registry";
import { StateBatcher, type StateField, type StoryCascade } from "./state-batcher";
import { planStoryCascade } from "./story-cascade";
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

/**
 * "Alles bis hier" as a server-side range of the bound list (`listKey`, its
 * `sort`): from the first loaded row `fromId` down to `toId`, plus folded story
 * members `extraIds`; `maxCreatedAt` = newest loaded row (keeps rows that
 * arrived later out). See `markRangeRead` on the server.
 */
export interface MarkRange {
  listKey: string;
  sort: "new" | "old";
  fromId: string;
  toId: string;
  maxCreatedAt: number;
  extraIds: string[];
}

export interface SetReadOptions {
  /** The row stands for its whole story (story card): the server cascades to the cluster. */
  story?: boolean;
}

export interface ArticleActions {
  setRead(id: string, read: boolean, src?: ToggleSource, opts?: SetReadOptions): void;
  toggleRead(id: string): void;
  toggleStar(id: string): void;
  toggleLater(id: string): void;
  setLabels(id: string, labelIds: string[]): void;
  fetchFullText(id: string): void;
  /** Bulk mark-read of a whole view with the 6 s Undo toast (server-issued undo token). */
  markViewRead(scope: MarkViewScope): void;
  /**
   * Bulk mark-read of explicit loaded rows ("Alles bis hier als gelesen") with
   * the same 6 s Undo toast (server-issued undo token).
   */
  markIdsRead(ids: string[]): void;
  /** Same, as one server-side range (no id cap; one undo token). */
  markRangeRead(range: MarkRange): void;
}

const MARK_VIEW_READ_KEY = ["mark-view-read"] as const;
const STORY_TOAST_ID = "story-cascade";

type BulkReadRequest = { kind: "scope"; scope: MarkViewScope } | { kind: "ids"; ids: string[] } | { kind: "range"; range: MarkRange };
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

  /**
   * Story cascades per originating article (the lead, or the source a story
   * card stood for): the ids the server marked read with it (Undo / the story
   * marked unread again).
   */
  const cascades = useRef(new Map<string, string[]>());

  /**
   * Marks the sources the story cascade marked read with `origin` unread again
   * (explicit ops through the batcher; rows no cache holds are sent as is).
   */
  const restoreCascade = useCallback((target: StateBatcher, origin: string) => {
    const members = cascades.current.get(origin);
    if (!members?.length) return;
    cascades.current.delete(origin);
    let unknown = false;
    for (const id of members) {
      const result = applyArticlePatch(qc, id, { isRead: false });
      if (result) target.enqueue({ id, field: "isRead", value: false }, result.before.isRead);
      else {
        // Not patched: unknown to the cache, or the cache already shows it unread
        // (cascade result skipped for a pending toggle) — the server has it read.
        if (!findCachedArticle(qc, id)) unknown = true;
        if (target.latestValue(id, "isRead") === undefined) target.enqueue({ id, field: "isRead", value: false }, true);
      }
    }
    if (unknown) invalidateCounts(qc);
  }, [qc]);

  const batcher = useMemo(() => {
    /**
     * The server marked stories' other sources read (story cascade). Per
     * story: patch its ids in every cache — except ids the user toggled since
     * (queued or in flight: that newer write wins and is not overwritten) —
     * remember them under the story's origin (marking it unread again
     * restores them) and offer one Undo for every story of this flush.
     */
    const applyStoryCascades = (groups: StoryCascade[]) => {
      const plan = planStoryCascade(
        groups,
        (id) => instance.latestValue(id, "isRead"),
        (origin) => instance.latestValue(origin, "isRead") ?? findCachedArticle(qc, origin)?.isRead,
      );
      for (const { origin, ids } of plan.groups) {
        const known = cachedArticles(qc, new Set(ids));
        applyBulkRead(qc, ids, true);
        if (known.size < ids.length) invalidateCounts(qc);
        cascades.current.set(origin, [...(cascades.current.get(origin) ?? []), ...ids]);
      }
      // The story was taken back while this call was in flight: undo its cascade right away.
      for (const origin of plan.restore) restoreCascade(instance, origin);
      if (plan.undo.length === 0) return;
      const { t: tr, tSidebar: ts } = tRef.current;
      toast(tr("storyMarkedRead", { count: plan.total }), {
        id: STORY_TOAST_ID,
        duration: 6000,
        action: { label: ts("undo"), onClick: () => plan.undo.forEach((origin) => restoreCascade(instance, origin)) },
      });
    };

    const instance = new StateBatcher({
      send: (ops) => applyArticleStateOps(ops),
      onSettled: ({ failed, cascades: groups }) => {
        if (groups.length > 0) applyStoryCascades(groups);
        if (failed.length === 0) return;
        rollbackFailedOps(qc, failed, (id, field) => instance.hasPending(id, field));
        toast.error(tRef.current.t("toggleFailed"), { id: FAILURE_TOAST_ID });
      },
    });
    return instance;
  }, [qc, restoreCascade]);

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
    mutationFn: async (undoToken: string) => {
      // Queued single toggles must reach the server first, or they would land
      // after the bulk write and leave server and cache disagreeing.
      batcher.flush();
      await batcher.whenIdle();
      return markArticlesAsUnread(undoToken);
    },
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
    mutationFn: async (request: BulkReadRequest) => {
      batcher.flush();
      await batcher.whenIdle();
      if (request.kind === "ids") return markArticleIdsRead(request.ids);
      if (request.kind === "range") return markListRangeRead(request.range);
      return markAllAsRead(request.scope);
    },
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
    const set = (id: string, field: StateField, value: boolean, story = false) => {
      if (guardOffline()) return;
      const result = applyArticlePatch(qc, id, { [field]: value });
      if (!result) return;
      batcher.enqueue({ id, field, value, ...(story && field === "isRead" && value ? { story: true } : {}) }, result.before[field]);
      // A story lead marked unread again brings back the sources its cascade marked read.
      if (field === "isRead" && !value && cascades.current.has(id)) restoreCascade(batcher, id);
    };
    const toggle = (id: string, field: StateField) => {
      const current = findCachedArticle(qc, id);
      if (current) set(id, field, !current[field]);
    };

    return {
      setRead: (id, read, _src, opts) => set(id, "isRead", read, !!opts?.story),
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
        markAllMutate({ kind: "scope", scope });
      },

      markIdsRead: (ids) => {
        if (guardOffline()) return;
        const unread = ids.filter((id) => findCachedArticle(qc, id)?.isRead === false);
        if (unread.length) markAllMutate({ kind: "ids", ids: unread });
      },

      markRangeRead: (range) => {
        if (guardOffline()) return;
        markAllMutate({ kind: "range", range });
      },
    };
  }, [qc, batcher, markAllMutate, fullTextMutate, restoreCascade]);

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
