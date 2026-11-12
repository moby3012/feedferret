"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { findCachedArticle } from "@/features/articles/cache";
import type { LegacyArticle, LegacyContext } from "@/features/articles/legacy-adapter";
import { useArticleActions } from "@/features/articles/mutations";
import { useOnline } from "@/features/bootstrap/queries";
import { getLayoutClass } from "@/features/reader/layout/layout-class";
import { updateUiPrefs, useUiPrefs } from "@/features/reader/layout/ui-prefs-context";
import { TAB_ROOTS } from "@/features/reader/nav/location";
import { getNavState, nav } from "@/features/reader/nav/store";
import { markArticleOpen } from "@/features/reader/perf-marks";
import { markInAppNavigation } from "@/lib/in-app-back";
import { requestSearchFocus } from "./tabs";
import {
  useCategories,
  useCreateSavedSearch,
  useFeeds,
  useLabels,
  useReadingPreferences,
  useRefresh,
  REFRESH_FEED_KEY,
  useSavedSearches,
  useUpdateGlobalSettings,
} from "@/hooks/use-rss-data";

// Shell-wide state and ONE stable actions object (spec §1.1: containers read
// the nav store and data hooks themselves; leaves get primitives + stable
// actions — no handler props threaded through the shell).

export type SortOrder = "newest" | "oldest";
export type ViewMode = "list" | "magazine" | "minimal";

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
  /** The feeds query answered (an empty `feeds` then means "no feeds", not "still loading"). */
  feedsLoaded: boolean;
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
  addFeed: { n: number; url?: string; tab?: "url" | "discover" };
  /** Query the save-search dialog names (open state = nav overlay "save-search"). */
  saveSearchQuery: string;
}

export interface ShellActions {
  activeList: ActiveListStore;
  selectArticle(article: { id: string; feedId: string; link?: string; openLink?: string }): void;
  /** `story`: the row is a story card (the server cascades the read to its cluster). */
  toggleRead(id: string, opts?: { story?: boolean }): void;
  toggleStar(id: string): void;
  toggleLater(id: string): void;
  /** Auto / scroll mark-read; respects the session snapshot and the suppression set. */
  markAutoRead(article: { id: string; isRead: boolean }, src?: "auto" | "scroll"): void;
  bindSession(key: string): void;
  /** The feeds tree: compact → Feeds tab; medium / collapsed rail → drawer. */
  openSources(): void;
  /** Suche tab with its field focused (`/`, palette, sidebar search icon). */
  openSearch(): void;
  /** Expanded layout: sidebar ⇄ rail (`[`); persisted in the `ff_ui` cookie. */
  toggleSourcesCollapsed(): void;
  /** Overlay "shortcuts" (open / close through the nav store). */
  setShortcutsOpen(open: boolean): void;
  /** Overlay "add-feed" (compact: on the Feeds root, spec §1.3 consumed params); `tab` picks the dialog tab. */
  requestAddFeed(url?: string, tab?: "url" | "discover"): void;
  /** Opens the save-search dialog for `q` (no window.prompt). */
  saveSearch(q: string): void;
  /** Saves `q` under `name` (the dialog's submit). */
  createSavedSearch(name: string, q: string): void;
  openSettings(): void;
  refresh(): void;
  setViewMode(mode: ViewMode): void;
  toggleSort(): void;
}

const DataContext = createContext<ShellData | null>(null);
/** Own context: the shell root reads it, and must not re-render on every data change. */
const CollapsedContext = createContext(false);
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
  const { data: feeds = [], isSuccess: feedsLoaded } = useFeeds(true);
  const { data: categories = [] } = useCategories(true);
  const { data: labels = [], isSuccess: labelsReady } = useLabels(true);
  const { data: savedSearches = [] } = useSavedSearches(true);
  const { data: prefs } = useReadingPreferences(true);
  const updateGlobalSettings = useUpdateGlobalSettings();
  const createSavedSearch = useCreateSavedSearch();
  const refreshMutation = useRefresh();
  // A single-feed refresh (sources menu) is an explicit refresh too.
  const isRefreshing = useIsMutating({ mutationKey: REFRESH_FEED_KEY }) > 0 || refreshMutation.isPending;

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
  const [saveSearchQuery, setSaveSearchQuery] = useState("");
  const uiPrefs = useUiPrefs();
  const [sourcesCollapsed, setSourcesCollapsed] = useState(() => !!uiPrefs.current.sidebarCollapsed);

  const legacyContext = useMemo<LegacyContext>(
    () => ({
      feedsById: new Map(feeds.map((f: any) => [f.id, f])),
      labelsById: new Map(labels.map((l: any) => [l.id, l])),
      labelsReady,
    }),
    [feeds, labels, labelsReady],
  );

  // Handlers read the latest values through a ref: the actions object never changes.
  const live = useRef({ feeds, prefs, online, session, suppressed, articleActions, refreshMutation, updateGlobalSettings, createSavedSearch, router, uiPrefs });
  live.current = { feeds, prefs, online, session, suppressed, articleActions, refreshMutation, updateGlobalSettings, createSavedSearch, router, uiPrefs };

  const actions = useMemo<ShellActions>(() => {
    const addSession = (id: string) =>
      setSession((s) => (s.ids.includes(id) ? s : { key: s.key, ids: [...s.ids, id] }));
    return {
      activeList: createActiveListStore(),
      selectArticle(article) {
        const { feeds: fs, prefs: p } = live.current;
        const feed = fs.find((f: any) => f.id === article.feedId);
        const openOriginal = feed?.openOriginalOverride ?? p?.openOriginalByDefault;
        if (openOriginal && article.link) window.open(article.openLink ?? article.link, "_blank", "noopener,noreferrer");
        markArticleOpen(article.id);
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
      openSources() {
        if (getLayoutClass() === "compact") void nav.goTo(TAB_ROOTS.feeds);
        else void nav.openOverlay("sources");
      },
      openSearch() {
        const { loc } = getNavState();
        const go = loc.tab === "search" && !loc.articleId ? nav.closeOverlay() : nav.goTab("search");
        void go.then(requestSearchFocus);
      },
      toggleSourcesCollapsed() {
        setSourcesCollapsed((prev) => {
          const next = !prev;
          updateUiPrefs(live.current.uiPrefs, { sidebarCollapsed: next });
          return next;
        });
      },
      setShortcutsOpen(open) {
        void (open ? nav.openOverlay("shortcuts") : nav.closeOverlay("shortcuts"));
      },
      requestAddFeed(url, tab) {
        setAddFeed((prev) => ({ n: prev.n + 1, url, tab }));
        const { loc } = getNavState();
        // Compact: the dialog sits on the Feeds root (Back lands there, not on a random list).
        if (getLayoutClass() === "compact" && (loc.tab !== "feeds" || loc.scope || loc.articleId)) void nav.goTo(TAB_ROOTS.feeds);
        void nav.openOverlay("add-feed");
      },
      saveSearch(q) {
        const query = q.trim();
        if (!query) return;
        setSaveSearchQuery(query);
        void nav.openOverlay("save-search");
      },
      createSavedSearch(name, q) {
        const query = q.trim();
        if (!query || !name.trim()) return;
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
      feedsLoaded,
      categories,
      labels,
      savedSearches,
      prefs,
      legacyContext,
      viewMode,
      sortOrder,
      isRefreshing,
      session,
      suppressed,
      addFeed,
      saveSearchQuery,
    }),
    [feeds, feedsLoaded, categories, labels, savedSearches, prefs, legacyContext, viewMode, sortOrder, isRefreshing, session, suppressed, addFeed, saveSearchQuery],
  );

  return (
    <ActionsContext.Provider value={actions}>
      <DataContext.Provider value={data}>
        <CollapsedContext.Provider value={sourcesCollapsed}>{children}</CollapsedContext.Provider>
      </DataContext.Provider>
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

/** Expanded layout: the sidebar is collapsed to the rail (`[`, `ff_ui` cookie → SSR). */
export function useSourcesCollapsed(): boolean {
  return useContext(CollapsedContext);
}
