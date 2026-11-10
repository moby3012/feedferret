"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { ViewMode } from "@/components/rss-header";
import { findCachedArticle } from "@/features/articles/cache";
import type { LegacyArticle, LegacyContext } from "@/features/articles/legacy-adapter";
import { useArticleActions } from "@/features/articles/mutations";
import { useOnline } from "@/features/bootstrap/queries";
import { getLayoutClass } from "@/features/reader/layout/layout-class";
import { TAB_ROOTS } from "@/features/reader/nav/location";
import { getNavState, nav } from "@/features/reader/nav/store";
import { markInAppNavigation } from "@/lib/in-app-back";
import {
  useCategories,
  useCreateSavedSearch,
  useFeeds,
  useLabels,
  useReadingPreferences,
  useRefresh,
  useSavedSearches,
  useUpdateGlobalSettings,
} from "@/hooks/use-rss-data";

// Shell-wide state and ONE stable actions object (spec §1.1: containers read
// the nav store and data hooks themselves; leaves get primitives + stable
// actions — no handler props threaded through the shell).

export type SortOrder = "newest" | "oldest";

/** The list the user is looking at (j/k, reader prev/next, prefetch). */
export interface ActiveList {
  key: string | null;
  articles: LegacyArticle[];
}

function createActiveListStore() {
  let value: ActiveList = { key: null, articles: [] };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: ActiveList) {
      if (next.key === value.key && next.articles === value.articles) return;
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type ActiveListStore = ReturnType<typeof createActiveListStore>;

export interface ShellData {
  feeds: any[];
  categories: any[];
  labels: any[];
  savedSearches: any[];
  prefs: any;
  legacyContext: LegacyContext;
  viewMode: ViewMode;
  sortOrder: SortOrder;
  isRefreshing: boolean;
  /** Rows read while bound to `session.key` stay visible in "unread only" until the list changes. */
  session: { key: string | null; ids: string[] };
  /** Opened articles the user marked unread again: auto mark-read skips them. */
  suppressed: string[];
  /** Last Add Feed request (`n` bumps per request; `url` = share-target prefill). Open state = nav overlay "add-feed". */
  addFeed: { n: number; url?: string };
}

export interface ShellActions {
  activeList: ActiveListStore;
  selectArticle(article: { id: string; feedId: string; link?: string }): void;
  /** `story`: the row is a story card (the server cascades the read to its cluster). */
  toggleRead(id: string, opts?: { story?: boolean }): void;
  toggleStar(id: string): void;
  toggleLater(id: string): void;
  /** Auto / scroll mark-read; respects the session snapshot and the suppression set. */
  markAutoRead(article: { id: string; isRead: boolean }, src?: "auto" | "scroll"): void;
  bindSession(key: string): void;
  openSources(): void;
  openSearch(): void;
  /** Overlay "shortcuts" (open / close through the nav store). */
  setShortcutsOpen(open: boolean): void;
  /** Overlay "add-feed" (compact: on the Feeds root, spec §1.3 consumed params). */
  requestAddFeed(url?: string): void;
  saveSearch(q: string): void;
  openSettings(): void;
  refresh(): void;
  setViewMode(mode: ViewMode): void;
  toggleSort(): void;
}

const DataContext = createContext<ShellData | null>(null);
const ActionsContext = createContext<ShellActions | null>(null);

function normalizeViewMode(value?: string | null): ViewMode {
  if (value === "minimal" || value === "magazine" || value === "list") return value;
  return value === "grid" ? "magazine" : "list";
}

function sortOrderOf(prefs: { defaultArticleSort?: string | null } | undefined): SortOrder {
  return prefs?.defaultArticleSort === "oldest" ? "oldest" : "newest";
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const router = useRouter();
  const articleActions = useArticleActions();
  const online = useOnline();
  // The server page already gated on the session: queries run right away.
  const { data: feeds = [] } = useFeeds(true);
  const { data: categories = [] } = useCategories(true);
  const { data: labels = [], isSuccess: labelsReady } = useLabels(true);
  const { data: savedSearches = [] } = useSavedSearches(true);
  const { data: prefs } = useReadingPreferences(true);
  const updateGlobalSettings = useUpdateGlobalSettings();
  const createSavedSearch = useCreateSavedSearch();
  const refreshMutation = useRefresh();

  // Prefs are in the cache at the first render after a cold start (server
  // bootstrap): start with the user's view mode / sort, so the server-rendered
  // rows are the ones that stay (no re-render, no layout shift, same list key).
  const [viewMode, setViewMode] = useState<ViewMode>(() => normalizeViewMode(prefs?.defaultViewMode));
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => sortOrderOf(prefs));
  const prefsApplied = useRef(!!prefs);
  useEffect(() => {
    if (!prefs || prefsApplied.current) return;
    prefsApplied.current = true;
    setViewMode(normalizeViewMode(prefs.defaultViewMode));
    setSortOrder(sortOrderOf(prefs));
  }, [prefs]);

  const [session, setSession] = useState<{ key: string | null; ids: string[] }>({ key: null, ids: [] });
  const [suppressed, setSuppressed] = useState<string[]>([]);
  const [addFeed, setAddFeed] = useState<ShellData["addFeed"]>({ n: 0 });

  const legacyContext = useMemo<LegacyContext>(
    () => ({
      feedsById: new Map(feeds.map((f: any) => [f.id, f])),
      labelsById: new Map(labels.map((l: any) => [l.id, l])),
      labelsReady,
    }),
    [feeds, labels, labelsReady],
  );

  // Handlers read the latest values through a ref: the actions object never changes.
  const live = useRef({ feeds, prefs, online, session, suppressed, articleActions, refreshMutation, updateGlobalSettings, createSavedSearch, router });
  live.current = { feeds, prefs, online, session, suppressed, articleActions, refreshMutation, updateGlobalSettings, createSavedSearch, router };

  const actions = useMemo<ShellActions>(() => {
    const addSession = (id: string) =>
      setSession((s) => (s.ids.includes(id) ? s : { key: s.key, ids: [...s.ids, id] }));
    return {
      activeList: createActiveListStore(),
      selectArticle(article) {
        const { feeds: fs, prefs: p } = live.current;
        const feed = fs.find((f: any) => f.id === article.feedId);
        const openOriginal = feed?.openOriginalOverride ?? p?.openOriginalByDefault;
        if (openOriginal && article.link) window.open(article.link, "_blank", "noopener,noreferrer");
        void nav.openArticle(article.id);
      },
      toggleRead(id, opts) {
        const article = findCachedArticle(qc, id);
        if (!article) return;
        const next = !article.isRead;
        const { online: isOnline, articleActions: a } = live.current;
        if (isOnline) {
          setSession((s) => ({ key: s.key, ids: next ? Array.from(new Set([...s.ids, id])) : s.ids.filter((x) => x !== id) }));
          setSuppressed((prev) => {
            if (next) return prev.filter((x) => x !== id);
            if (getNavState().loc.articleId !== id) return prev;
            return Array.from(new Set([...prev, id]));
          });
        }
        a.setRead(id, next, "tap", opts); // offline: refused with the offline toast
      },
      toggleStar: (id) => live.current.articleActions.toggleStar(id),
      toggleLater: (id) => live.current.articleActions.toggleLater(id),
      markAutoRead(article, src = "auto") {
        const { session: s, suppressed: sup, articleActions: a } = live.current;
        if (article.isRead || s.ids.includes(article.id) || sup.includes(article.id)) return;
        addSession(article.id);
        a.setRead(article.id, true, src);
      },
      bindSession(key) {
        setSession((s) => (s.key === key ? s : { key, ids: [] }));
        setSuppressed((prev) => (prev.length ? [] : prev));
      },
      openSources: () => void nav.openOverlay("sources"),
      openSearch: () => void nav.openOverlay("search"),
      setShortcutsOpen(open) {
        void (open ? nav.openOverlay("shortcuts") : nav.closeOverlay("shortcuts"));
      },
      requestAddFeed(url) {
        setAddFeed((prev) => ({ n: prev.n + 1, url }));
        const { loc } = getNavState();
        // Compact: the dialog sits on the Feeds root (Back lands there, not on a random list).
        if (getLayoutClass() === "compact" && (loc.tab !== "feeds" || loc.scope || loc.articleId)) void nav.goTo(TAB_ROOTS.feeds);
        void nav.openOverlay("add-feed");
      },
      saveSearch(q) {
        const query = q.trim();
        if (!query) return;
        const name = window.prompt("Name for this saved search", query.length > 40 ? `${query.slice(0, 40)}…` : query);
        if (!name?.trim()) return;
        live.current.createSavedSearch.mutate({ name: name.trim(), query });
      },
      openSettings() {
        markInAppNavigation();
        live.current.router.push("/settings");
      },
      refresh: () => live.current.refreshMutation.mutate(),
      setViewMode,
      toggleSort() {
        setSortOrder((prev) => {
          const next = prev === "newest" ? "oldest" : "newest";
          live.current.updateGlobalSettings.mutate({ defaultArticleSort: next });
          return next;
        });
      },
    };
  }, [qc]);

  const data = useMemo<ShellData>(
    () => ({
      feeds,
      categories,
      labels,
      savedSearches,
      prefs,
      legacyContext,
      viewMode,
      sortOrder,
      isRefreshing: refreshMutation.isPending,
      session,
      suppressed,
      addFeed,
    }),
    [feeds, categories, labels, savedSearches, prefs, legacyContext, viewMode, sortOrder, refreshMutation.isPending, session, suppressed, addFeed],
  );

  return (
    <ActionsContext.Provider value={actions}>
      <DataContext.Provider value={data}>{children}</DataContext.Provider>
    </ActionsContext.Provider>
  );
}

export function useShellData(): ShellData {
  const value = useContext(DataContext);
  if (!value) throw new Error("useShellData() outside <ShellProvider>");
  return value;
}

export function useShellActions(): ShellActions {
  const value = useContext(ActionsContext);
  if (!value) throw new Error("useShellActions() outside <ShellProvider>");
  return value;
}
