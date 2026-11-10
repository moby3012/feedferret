"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { RssSidebar } from "@/components/rss-sidebar";
import { ArticleList } from "@/components/article-list";
import { ArticleReader } from "@/components/article-reader";
import { RssHeader, ViewMode } from "@/components/rss-header";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { MobileBottomControls } from "@/components/mobile-bottom-controls";
import { EndOfListCard } from "@/components/end-of-list-card";
import { SearchResultsView } from "@/components/search-results-view";
import { isMarkAllAllowed } from "@/lib/view-scope";
import {
  useFeeds,
  useRefresh,
  useLabels,
  useCategories,
  useSavedSearches,
  useCreateSavedSearch,
  useReadingPreferences,
  useUpdateGlobalSettings,
  useReleaseArticleSpoiler,
  useReleaseAllSpoilers,
} from "@/hooks/use-rss-data";
import { CommandPalette } from "@/components/command-palette";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Search as SearchIcon, X as XIcon } from "lucide-react";
import { SpoilerIcon } from "@/components/icons/spoiler-icon";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useDefaultLayout } from "react-resizable-panels";
import { hasUsers } from "./actions/onboarding";
import { useRouter } from "next/navigation";
import { useAppBadge } from "@/hooks/use-app-badge";
import { useDebounce } from "@/hooks/use-debounce";
import { useQueryClient } from "@tanstack/react-query";
import { useArticle, useArticleList } from "@/features/articles/queries";
import { listKeyOf } from "@/features/articles/scope";
import { qk } from "@/features/articles/keys";
import { fetchArticleDetail } from "@/features/articles/api";
import { legacyScope, toLegacyArticle, withDetail, type LegacyContext } from "@/features/articles/legacy-adapter";
import { useArticleActions, useIsFetchingFullText, useIsMarkingViewRead } from "@/features/articles/mutations";
import { prefetchArticle } from "@/features/articles/prefetch";
import { findCachedArticle } from "@/features/articles/cache";
import { useCounts, useOnline, useScopeUnread } from "@/features/bootstrap/queries";
import { OfflineChip } from "@/components/shell/offline-chip";

const ssrSafeStorage = {
  getItem: (key: string) => (typeof window !== "undefined" ? localStorage.getItem(key) : null),
  setItem: (key: string, value: string) => { if (typeof window !== "undefined") localStorage.setItem(key, value); },
};

function normalizeViewMode(value?: string | null): ViewMode {
  if (value === "minimal" || value === "magazine" || value === "list") {
    return value;
  }
  if (value === "grid") {
    return "magazine";
  }
  return "list";
}

export default function RSSReaderPage() {
  const t = useTranslations("sidebar");
  const tA11y = useTranslations("accessibility");
  const tSearch = useTranslations("searchResults");
  const { data: session, status } = useSession();
  const router = useRouter();

  const [selectedFeed, setSelectedFeed] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(
    null,
  );
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [viewModeInitialized, setViewModeInitialized] = useState(false);
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [sortOrderInitialized, setSortOrderInitialized] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [transitionStyle, setTransitionStyle] = useState<"fade" | "flip" | "filter">("fade");
  const [searchQuery, setSearchQuery] = useState("");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Monotonic counter rather than a boolean so repeated triggers (e.g. from
  // the command palette) re-fire the effect in RssSidebar even if the
  // dialog was already opened once before in this session.
  const [openAddFeed, setOpenAddFeed] = useState(0);
  // F7: PWA share-target deep link (?sharedUrl=...) — pre-fills the Add-Feed
  // dialog's "From web page" tab so a share sheet drops straight into Scout
  // Studio's page→feed builder.
  const [sharedWebpageUrl, setSharedWebpageUrl] = useState<string | undefined>(undefined);
  const [isMobileLayout, setIsMobileLayout] = useState<boolean | null>(null);
  const [isClosingReader, setIsClosingReader] = useState(false);
  const isAuthenticated = status === "authenticated";

  const { data: feeds = [], isLoading: feedsLoading } = useFeeds(isAuthenticated);
  const { data: categories = [] } = useCategories(isAuthenticated);
  const debouncedSearchQuery = useDebounce(searchQuery, 300);
  const isSearchActive = Boolean(debouncedSearchQuery.trim());
  const queryClient = useQueryClient();

  // Slim, server-filtered, paged list (GET /api/app/articles, 50 rows/page,
  // no bodies). The unread filter runs on the server for all/feed/category/
  // label/saved-search; smart views and search ignore `show` (filtered below).
  const listScope = useMemo(
    () => legacyScope(isSearchActive ? null : selectedFeed, isSearchActive ? "All Articles" : selectedCategory, debouncedSearchQuery, categories),
    [isSearchActive, selectedFeed, selectedCategory, debouncedSearchQuery, categories],
  );
  const listKey = useMemo(
    () => (listScope ? listKeyOf(listScope, unreadOnly ? "unread" : "all", sortOrder === "oldest" ? "old" : "new") : null),
    [listScope, unreadOnly, sortOrder],
  );
  // Ids (never article copies: the query cache owns every article field) of
  // rows read in this view: they stay visible in "unread only" until the view
  // changes. Bulk mark-read is not in here, so its rows leave the view.
  const [readInSession, setReadInSession] = useState<string[]>([]);
  const articleList = useArticleList(listKey, { active: isAuthenticated });
  const rawArticles = articleList.items;
  const articlesLoading = articleList.status === "pending" && isAuthenticated;

  // Header / sidebar / badge numbers: one `["counts"]` entry, patched
  // optimistically by every toggle (features/articles/cache.ts).
  const counts = useCounts(isAuthenticated);
  const scopeUnread = useScopeUnread(listScope, feeds, isAuthenticated);

  const refresh = useRefresh();
  const actions = useArticleActions();
  const { markViewRead } = actions;
  const isMarkingAllRead = useIsMarkingViewRead();
  const isFetchingFullText = useIsFetchingFullText();
  const online = useOnline();
  const { data: labels = [], isSuccess: labelsReady } = useLabels(isAuthenticated);
  const { data: savedSearches = [] } = useSavedSearches(isAuthenticated);
  const createSavedSearch = useCreateSavedSearch();
  const { data: readingPrefs } = useReadingPreferences(isAuthenticated);
  const updateGlobalSettings = useUpdateGlobalSettings();
  const releaseArticleSpoiler = useReleaseArticleSpoiler();
  const releaseAllSpoilers = useReleaseAllSpoilers();

  const unreadBadgeCount = useMemo(
    () => Object.values(counts.byFeed).reduce((sum, n) => sum + n, 0),
    [counts.byFeed],
  );
  useAppBadge(unreadBadgeCount, status === "authenticated");

  const { defaultLayout: readerLayout, onLayoutChanged: onReaderLayoutChanged } =
    useDefaultLayout({ id: "feedferret-reader-layout", panelIds: ["article-list", "article-reader"], storage: ssrSafeStorage });

  const [autoReadSuppressedArticles, setAutoReadSuppressedArticles] = useState<string[]>([]);
  const [lastClosedArticleId, setLastClosedArticleId] = useState<string | null>(null);
  const deepLinkAppliedRef = useRef(false);
  const articleDeepLinkRef = useRef<string | null>(null);
  const initialSyncFailedToastShownRef = useRef(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1023px)");
    const updateLayout = () => setIsMobileLayout(mediaQuery.matches);

    updateLayout();
    mediaQuery.addEventListener("change", updateLayout);
    return () => mediaQuery.removeEventListener("change", updateLayout);
  }, []);

  // Initialize viewMode from user prefs (once loaded)
  useEffect(() => {
    if (readingPrefs && !viewModeInitialized) {
      setViewMode(normalizeViewMode(readingPrefs.defaultViewMode));
      setViewModeInitialized(true);
    }
    if (readingPrefs && !sortOrderInitialized) {
      setSortOrder(readingPrefs.defaultArticleSort === "oldest" ? "oldest" : "newest");
      setSortOrderInitialized(true);
    }
  }, [readingPrefs, sortOrderInitialized, viewModeInitialized]);

  // Reset readInSession when feed or category changes
  useEffect(() => {
    setReadInSession([]);
    setAutoReadSuppressedArticles([]);
  }, [selectedFeed, selectedCategory]);

  // Spoiler feed needs an explicit "reveal" each time the user enters it so
  // they never see spoilers without a deliberate click.
  const [spoilerRevealed, setSpoilerRevealed] = useState(false);
  const isSpoilerCategory = selectedCategory === "Spoiler" && !selectedFeed;
  useEffect(() => {
    if (!isSpoilerCategory) setSpoilerRevealed(false);
  }, [isSpoilerCategory, selectedCategory, selectedFeed]);

  const spoilerGate = (
    <div className="flex-1 flex items-center justify-center p-8 animate-fade-in">
      <div className="max-w-md text-center space-y-5">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-warning/10 text-warning">
          <SpoilerIcon className="h-8 w-8" />
        </div>
        <div className="space-y-2">
          <h3 className="text-xl font-semibold tracking-tight">{t("spoilerAhead")}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t("spoilerDescription")}
          </p>
        </div>
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => setSpoilerRevealed(true)}
            className="rounded-2xl bg-warning-subtle px-6 py-3 text-sm font-semibold text-warning shadow-sm hover:bg-warning/20 active:scale-[0.98] transition-all"
          >
            {t("revealSpoilers")}
          </button>
          <button
            type="button"
            onClick={() => {
              releaseAllSpoilers.mutate(undefined, {
                onSuccess: () => { setSelectedCategory("All"); setSelectedFeed(null); },
              });
            }}
            disabled={releaseAllSpoilers.isPending}
            className="text-xs text-warning hover:underline disabled:opacity-50"
          >
            {releaseAllSpoilers.isPending ? t("clearingSpoilerFlags") : t("clearSpoilerFlags")}
          </button>
          <button
            type="button"
            onClick={() => { setSelectedCategory("All"); setSelectedFeed(null); }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {t("takeMeBack")}
          </button>
        </div>
      </div>
    </div>
  );

  useEffect(() => {
    if (deepLinkAppliedRef.current || status !== "authenticated") return;
    deepLinkAppliedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const view = params.get("view");
    const articleId = params.get("article");
    if (articleId) articleDeepLinkRef.current = articleId;

    if (view === "new") {
      setSelectedCategory("All Articles");
      setUnreadOnly(true);
      setSelectedFeed(null);
    } else if (view === "readlater") {
      setSelectedCategory("Read Later");
      setSelectedFeed(null);
    } else if (view === "starred") {
      setSelectedCategory("Starred");
      setSelectedFeed(null);
    } else if (view === "all") {
      setSelectedCategory("All Articles");
      setSelectedFeed(null);
    }

    if (params.get("addFeed") === "1") {
      setOpenAddFeed((n) => n + 1);
      // On mobile the sidebar (and the add-feed flow inside it) only mounts
      // inside a Sheet gated by sidebarOpen — without this the deep link
      // silently did nothing there, since nothing else opens the sheet.
      setSidebarOpen(true);
    }

    // F7: PWA share-target ("Share → FeedFerret" from the OS share sheet).
    // The manifest's share_target maps the share's `url` field onto a
    // `sharedUrl` query param (and `text` onto `sharedText`, for apps that
    // only fill in the free-text field with a link instead). Opens the
    // Add-Feed dialog straight on the "From web page" tab, pre-filled.
    const sharedUrlParam = params.get("sharedUrl");
    const sharedTextParam = params.get("sharedText");
    const candidateSharedUrl =
      sharedUrlParam || (sharedTextParam && /^https?:\/\//i.test(sharedTextParam.trim()) ? sharedTextParam.trim() : null);
    if (candidateSharedUrl) {
      setSharedWebpageUrl(candidateSharedUrl);
      setOpenAddFeed((n) => n + 1);
      setSidebarOpen(true);
    }
  }, [status]);

  // Open search modal when sidebar search icon is clicked
  useEffect(() => {
    const handler = () => setSearchOpen(true);
    window.addEventListener('focus-search', handler);
    return () => window.removeEventListener('focus-search', handler);
  }, []);

  // Auto-sync feeds on page load (lazy sync)
  useEffect(() => {
    if (isAuthenticated) {
      fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }).then((res) => {
        if (!res.ok) throw new Error(`Sync request failed (${res.status})`);
        if (typeof window !== "undefined") {
          localStorage.setItem("lastSync", new Date().toISOString());
        }
      }).catch(() => {
        // Only surface a toast for the initial load's sync failure — background
        // refreshes (e.g. re-auth, tab refocus) shouldn't spam the user.
        if (!initialSyncFailedToastShownRef.current) {
          initialSyncFailedToastShownRef.current = true;
          toast.error(t("syncFailedToast"));
        }
      });
    }
  }, [isAuthenticated, t]);

  // Adapt the slim rows to the existing list/reader components (field copies
  // only, memoized per row — no body parsing per article any more).
  const legacyContext = useMemo<LegacyContext>(
    () => ({
      feedsById: new Map(feeds.map((f: any) => [f.id, f])),
      labelsById: new Map(labels.map((l: any) => [l.id, l])),
      labelsReady,
    }),
    [feeds, labels, labelsReady],
  );
  const displayArticles = useMemo(
    () => rawArticles.map((a) => toLegacyArticle(a, legacyContext)),
    [rawArticles, legacyContext],
  );

  // Body on demand (GET /api/app/articles/:id): the reader paints title/meta
  // from the list row at once and the server-rendered HTML when it arrives.
  // `item` is the article as any cache knows it (detail or any list), so the
  // reader keeps it after the list moves on (deep link, refresh, other view).
  const { item: selectedCachedItem, detail: selectedDetail, status: selectedDetailStatus } = useArticle(selectedArticleId);
  const selectedArticle = useMemo(() => {
    if (!selectedArticleId) return null;
    const inList = displayArticles.find((a: any) => a.id === selectedArticleId);
    if (inList) return inList;
    return selectedCachedItem ? toLegacyArticle(selectedCachedItem, legacyContext) : null;
  }, [displayArticles, selectedArticleId, selectedCachedItem, legacyContext]);
  const readerArticle = useMemo(
    () => (selectedArticle ? withDetail(selectedArticle, selectedDetail) : null),
    [selectedArticle, selectedDetail],
  );
  const isReaderBodyLoading = !!selectedArticle && selectedDetailStatus === "pending";

  const loadedUnreadCount = useMemo(
    () => displayArticles.filter((a: any) => !a.isRead).length,
    [displayArticles],
  );
  // From `["counts"]` (or the per-scope server count for search / saved
  // search / Starred / Read later) once known; until then what is loaded.
  const unreadCount = scopeUnread ?? loadedUnreadCount;

  useEffect(() => {
    const articleId = articleDeepLinkRef.current;
    if (!articleId || selectedArticleId) return;
    const article = displayArticles.find((item: any) => item.id === articleId);
    if (article) {
      setSelectedArticleId(article.id);
      articleDeepLinkRef.current = null;
      return;
    }
    // Not on the first list page (lists are paged now): open it by id.
    if (articleList.status !== "ready") return;
    articleDeepLinkRef.current = null;
    queryClient
      .fetchQuery({ queryKey: qk.article(articleId), queryFn: ({ signal }) => fetchArticleDetail(articleId, signal), staleTime: 5 * 60_000 })
      .then((detail) => setSelectedArticleId(detail.id))
      .catch(() => { /* unknown or foreign id: stay on the list */ });
  }, [displayArticles, selectedArticleId, articleList.status, queryClient]);


  // Rows come in server order (keyset: publishedAt, createdAt, id — or read
  // time for "Recently read"). "Unread only" hides rows that are read, except
  // the ones read in this view (snapshot semantics: they stay, dimmed, until
  // the view changes). Server-filtered lists only contain such rows after a
  // bulk mark-read; smart views and search are filtered here.
  const filteredArticles = useMemo(() => {
    if (!unreadOnly) return displayArticles;
    const keep = new Set(readInSession);
    return displayArticles.filter((a) => !a.isRead || keep.has(a.id));
  }, [displayArticles, unreadOnly, readInSession]);

  const selectedArticleIndex = useMemo(
    () => filteredArticles.findIndex((article: any) => article.id === selectedArticleId),
    [filteredArticles, selectedArticleId],
  );

  const headerTitle = useMemo(() => {
    if (selectedFeed) {
      return feeds.find((f: any) => f.id === selectedFeed)?.name || t("feedFallback");
    }
    if (selectedCategory.startsWith("Label:")) {
      return labels.find((label: any) => label.id === selectedCategory.slice("Label:".length))?.name || t("labelFallback");
    }
    if (selectedCategory.startsWith("Search:")) {
      return savedSearches.find((search: any) => search.id === selectedCategory.slice("Search:".length))?.name || t("savedSearchFallback");
    }
    // These are internal sentinel values (also used as sidebar categoryIds),
    // not display strings — translate the known ones. Anything else is a
    // real user-created category name and passes through as-is.
    const sentinelLabels: Record<string, string> = {
      All: t("allArticles"),
      "All Articles": t("allArticles"),
      Starred: t("starred"),
      "Read Later": t("readLater"),
      Spoiler: t("spoiler"),
    };
    return sentinelLabels[selectedCategory] ?? selectedCategory;
  }, [selectedFeed, selectedCategory, feeds, labels, savedSearches, t]);

  const markArticleRead = useCallback((article: any) => {
    if (
      !article ||
      article.isRead ||
      readInSession.includes(article.id) ||
      autoReadSuppressedArticles.includes(article.id)
    ) return;
    setReadInSession((prev) => [...prev, article.id]);
    setAutoReadSuppressedArticles((prev) => prev.filter((id) => id !== article.id));
    actions.setRead(article.id, true, "auto");
  }, [autoReadSuppressedArticles, readInSession, actions]);

  const handleSelectArticle = useCallback((article: any) => {
    setSelectedArticleId(article.id);
    const articleFeed = feeds.find((f: any) => f.id === article.feedId);
    const openOriginal = articleFeed?.openOriginalOverride ?? readingPrefs?.openOriginalByDefault;
    if (openOriginal && article.link) {
      window.open(article.link, "_blank", "noopener,noreferrer");
    }
  }, [feeds, readingPrefs?.openOriginalByDefault]);

  const handleCloseArticle = useCallback(() => {
    setLastClosedArticleId(selectedArticleIdRef.current);
    setSelectedArticleId(null);
  }, []);

  const handleMobileBack = useCallback(() => {
    setIsClosingReader(true);
    setTimeout(() => {
      handleCloseArticle();
      setIsClosingReader(false);
    }, 240);
  }, [handleCloseArticle]);

  const handleOpenArticleFeed = useCallback((feedId: string) => {
    setSelectedFeed(feedId);
    setSelectedCategory("All");
    setSelectedArticleId(null);
    setSidebarOpen(false);
  }, []);

  // Shared feed/category selection logic used by the desktop sidebar, the
  // mobile drawer, and the command palette so the behavior stays identical
  // across all three entry points.
  const handleSelectFeedNav = useCallback((feedId: string | null) => {
    setSelectedFeed(feedId);
    setSelectedArticleId(null);
    if (feedId) {
      setSelectedCategory("All");
      setUnreadOnly(true);
    }
  }, []);

  const handleSelectCategoryNav = useCallback((category: string) => {
    setSelectedCategory(category);
    setSelectedFeed(null);
    setSelectedArticleId(null);
    const noUnreadFilter = category === "Starred" || category === "Read Later";
    setUnreadOnly(!noUnreadFilter);
  }, []);

  const handleSelectLabelNav = useCallback((labelId: string) => {
    handleSelectCategoryNav(`Label:${labelId}`);
  }, [handleSelectCategoryNav]);

  const handleOpenAddFeed = useCallback(() => {
    setOpenAddFeed((n) => n + 1);
  }, []);

  const handleOpenSettings = useCallback(() => {
    router.push("/settings");
  }, [router]);

  const handleSelectAdjacentArticle = useCallback((direction: 1 | -1) => {
    const currentIndex = filteredArticlesRef.current.findIndex(
      (article: any) => article.id === selectedArticleIdRef.current,
    );
    const nextArticle = filteredArticlesRef.current[currentIndex + direction];
    if (nextArticle) handleSelectArticle(nextArticle);
  }, [handleSelectArticle]);

  useEffect(() => {
    if (
      !selectedArticle ||
      selectedArticle.isRead ||
      readInSession.includes(selectedArticle.id) ||
      autoReadSuppressedArticles.includes(selectedArticle.id)
    ) {
      return;
    }

    const delaySecs = readingPrefs?.markReadAfterDelaySecs ?? null;
    if (delaySecs === 0) return; // disabled
    const delayMs = delaySecs !== null ? delaySecs * 1000 : 1000;
    const timer = window.setTimeout(() => {
      markArticleRead(selectedArticle);
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [selectedArticle, readInSession, autoReadSuppressedArticles, markArticleRead, readingPrefs?.markReadAfterDelaySecs]);

  // Toggles: the cache is patched synchronously (same frame), the write goes
  // through the state batcher; a failed write rolls back exactly that field.
  const handleToggleRead = useCallback((articleId: string) => {
    const article = findCachedArticle(queryClient, articleId);
    if (!article) return;
    const nextIsRead = !article.isRead;
    if (!online) {
      actions.setRead(articleId, nextIsRead, "tap"); // refused with the offline toast
      return;
    }
    setReadInSession((prev) =>
      nextIsRead ? Array.from(new Set([...prev, articleId])) : prev.filter((id) => id !== articleId),
    );
    setAutoReadSuppressedArticles((prev) => {
      if (nextIsRead) return prev.filter((id) => id !== articleId);
      if (selectedArticleIdRef.current !== articleId) return prev;
      return Array.from(new Set([...prev, articleId]));
    });
    actions.setRead(articleId, nextIsRead, "tap");
  }, [actions, online, queryClient]);

  const handleToggleStar = useCallback((articleId: string) => actions.toggleStar(articleId), [actions]);
  const handleToggleReadLater = useCallback((articleId: string) => actions.toggleLater(articleId), [actions]);

  const handleRefresh = useCallback(() => {
    refresh.mutate();
  }, [refresh]);

  // Whether "mark all read" applies to the current view. Read-only views
  // (Recently Read, Spoiler) have nothing to mark, so every control is hidden.
  const canMarkAllRead = isSearchActive || isMarkAllAllowed(selectedFeed, selectedCategory);

  // Explicit "mark all read": marks exactly the current view (feed / category /
  // label / saved search / active search) and stays on it (no auto-jump).
  // Every entry point (header, end card, palette, shortcut) shares this handler.
  const handleMarkAllRead = useCallback(() => {
    if (!canMarkAllRead) return;
    if (isSearchActive) {
      markViewRead({ feedId: null, category: "All Articles", search: debouncedSearchQuery });
      return;
    }
    markViewRead({ feedId: selectedFeed, category: selectedFeed ? null : selectedCategory, categoryId: listScope?.kind === "category" ? listScope.id : null });
  }, [canMarkAllRead, isSearchActive, debouncedSearchQuery, markViewRead, selectedFeed, selectedCategory, listScope]);

  const toggleUnreadOnly = useCallback(() => {
    setTransitionStyle("filter");
    setUnreadOnly((prev) => !prev);
  }, []);

  // Decay the transition style back to fade after the keyframe finishes
  useEffect(() => {
    if (transitionStyle === "fade") return;
    const id = window.setTimeout(() => setTransitionStyle("fade"), 360);
    return () => window.clearTimeout(id);
  }, [transitionStyle, unreadOnly, selectedFeed, selectedCategory]);

  // Next feed (in sidebar order, wrapping) that still has unread articles. Only
  // offered when a single feed is open: switching feeds is a deliberate tap on
  // the end-of-list card, never a swipe or overscroll.
  const nextFeedWithUnread = useMemo(() => {
    if (!selectedFeed || isSearchActive) return null;
    const currentIdx = feeds.findIndex((f) => f.id === selectedFeed);
    if (currentIdx === -1) return null;
    const ordered = [...feeds.slice(currentIdx + 1), ...feeds.slice(0, currentIdx)];
    return ordered.find((f) => (counts.byFeed[f.id] ?? 0) > 0) ?? null;
  }, [feeds, selectedFeed, isSearchActive, counts.byFeed]);

  const handleContinueToNextFeed = useCallback(() => {
    if (!nextFeedWithUnread) return;
    // Opt-in setting: moving on also marks the view you are leaving read (with Undo).
    if (readingPrefs?.markReadOnAdvance && unreadCount > 0) {
      markViewRead({ feedId: selectedFeed, category: null });
    }
    setSelectedFeed(nextFeedWithUnread.id);
    setSelectedCategory("All");
    setSelectedArticleId(null);
    setTransitionStyle("flip");
  }, [nextFeedWithUnread, readingPrefs?.markReadOnAdvance, unreadCount, markViewRead, selectedFeed]);

  const endOfListCard = (
    <EndOfListCard
      caughtUp={unreadCount === 0}
      onMarkAllRead={canMarkAllRead ? handleMarkAllRead : undefined}
      isMarkingAllRead={isMarkingAllRead}
      nextFeedName={nextFeedWithUnread?.name ?? null}
      onContinue={handleContinueToNextFeed}
      continueMarksRead={readingPrefs?.markReadOnAdvance ?? false}
    />
  );

  const handleToggleSort = useCallback(() => {
    setSortOrder((prev) => {
      const next = prev === "newest" ? "oldest" : "newest";
      updateGlobalSettings.mutate({ defaultArticleSort: next });
      return next;
    });
  }, [updateGlobalSettings]);

  // The new body arrives through the refetched article detail.
  const handleFetchFullText = useCallback((articleId: string) => actions.fetchFullText(articleId), [actions]);
  // Optimistic (labels + label counts), rolled back on failure.
  const handleSetLabels = useCallback((articleId: string, labelIds: string[]) => actions.setLabels(articleId, labelIds), [actions]);

  const handleSaveSearch = useCallback(() => {
    const query = searchQuery.trim();
    if (!query) return;
    const name = window.prompt("Name for this saved search", query.length > 40 ? `${query.slice(0, 40)}…` : query);
    if (!name?.trim()) return;
    createSavedSearch.mutate({ name: name.trim(), query });
  }, [createSavedSearch, searchQuery]);

  const handleCloseSearch = useCallback(() => {
    setSearchQuery("");
    setSearchOpen(false);
    setSelectedArticleId(null);
  }, []);

  const handleEditSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);

  // Prefetch on intent: a row's body starts loading on pointerdown (before
  // the click); after opening the reader, the next two bodies when idle.
  const handleListPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input")) return; // row actions (star, read, …) need no body
    const id = target.closest("[data-article-id]")?.getAttribute("data-article-id");
    if (id) prefetchArticle(queryClient, id);
  }, [queryClient]);

  useEffect(() => {
    if (!selectedArticleId) return;
    const list = filteredArticlesRef.current;
    const at = list.findIndex((a: any) => a.id === selectedArticleId);
    if (at === -1) return;
    const next = list.slice(at + 1, at + 3);
    const run = () => next.forEach((a: any) => prefetchArticle(queryClient, a.id));
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(run, { timeout: 2000 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(run, 300);
    return () => window.clearTimeout(handle);
  }, [selectedArticleId, queryClient]);

  // Use refs for keyboard navigation to avoid stale closures
  const filteredArticlesRef = useRef(filteredArticles);
  const selectedArticleIdRef = useRef(selectedArticleId);
  const selectedArticleRef = useRef(selectedArticle);
  useEffect(() => {
    selectedArticleRef.current = selectedArticle;
  }, [selectedArticle]);
  useEffect(() => {
    filteredArticlesRef.current = filteredArticles;
  }, [filteredArticles]);
  useEffect(() => {
    selectedArticleIdRef.current = selectedArticleId;
  }, [selectedArticleId]);

  // Keyboard Shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target instanceof HTMLElement && e.target.isContentEditable)
    )
      return;

    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const currentFilteredArticles = filteredArticlesRef.current;
    const currentSelectedArticleId = selectedArticleIdRef.current;

    // "?" toggles help overlay (Shift+/ on most layouts)
    if (e.key === "?") {
      e.preventDefault();
      setShortcutsOpen((open) => !open);
      return;
    }

    // "/" to open search modal
    if (e.key === "/") {
      e.preventDefault();
      setSearchOpen(true);
    } else if (e.key === "Escape") {
      setShortcutsOpen(false);
    } else if (e.key === "j") {
      const currentIndex = currentFilteredArticles.findIndex(
        (a) => a.id === currentSelectedArticleId,
      );
      const nextArticle = currentFilteredArticles[currentIndex + 1];
      if (nextArticle) handleSelectArticle(nextArticle);
    } else if (e.key === "k") {
      const currentIndex = currentFilteredArticles.findIndex(
        (a) => a.id === currentSelectedArticleId,
      );
      const prevArticle = currentFilteredArticles[currentIndex - 1];
      if (prevArticle) handleSelectArticle(prevArticle);
    } else if (e.key === "n") {
      const startIdx = currentFilteredArticles.findIndex((a) => a.id === currentSelectedArticleId);
      const next = currentFilteredArticles
        .slice(startIdx + 1)
        .find((a: any) => !a.isRead);
      if (next) handleSelectArticle(next);
    } else if (e.key === "p") {
      const startIdx = currentFilteredArticles.findIndex((a) => a.id === currentSelectedArticleId);
      const slice = startIdx < 0 ? [] : currentFilteredArticles.slice(0, startIdx);
      for (let i = slice.length - 1; i >= 0; i--) {
        if (!slice[i].isRead) {
          handleSelectArticle(slice[i]);
          break;
        }
      }
    } else if (e.key === "s" && currentSelectedArticleId) {
      handleToggleStar(currentSelectedArticleId);
    } else if (e.key === "l" && currentSelectedArticleId) {
      handleToggleReadLater(currentSelectedArticleId);
    } else if (e.key === "m" && currentSelectedArticleId) {
      handleToggleRead(currentSelectedArticleId);
    } else if (e.key === "o" && selectedArticleRef.current?.link) {
      window.open(selectedArticleRef.current.link, "_blank", "noopener,noreferrer");
    } else if (e.key === "r") {
      handleRefresh();
    } else if (e.key === "A" && e.shiftKey) {
      e.preventDefault();
      handleMarkAllRead();
    } else if (e.key === "S" && e.shiftKey) {
      e.preventDefault();
      handleSaveSearch();
    }
  }, [handleSelectArticle, handleToggleStar, handleToggleReadLater, handleToggleRead, handleRefresh, handleMarkAllRead, handleSaveSearch]);

  useEffect(() => {
    if (status !== "unauthenticated") return;
    let cancelled = false;
    async function redirectUnauthenticated() {
      // First run (no account yet) → onboarding; otherwise the session is
      // missing/expired → send the user to log in instead of leaving them
      // stranded on an empty feed view. router.replace so the dead-end page
      // doesn't end up in history.
      try {
        const hasExistingUsers = await hasUsers();
        if (cancelled) return;
        router.replace(hasExistingUsers ? "/login" : "/setup");
      } catch {
        if (!cancelled) router.replace("/login");
      }
    }
    redirectUnauthenticated();
    return () => {
      cancelled = true;
    };
  }, [status, router]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [handleKeyDown]);

  // While loading, or while the unauthenticated redirect above is in flight,
  // show the loader instead of flashing the empty (feed-less) app shell.
  if (status === "loading" || status === "unauthenticated") {
    return (
      <div className="h-dvh flex items-center justify-center bg-background">
        <div className="relative w-20 h-20">
          <div className="absolute inset-0 border-4 border-primary/20 rounded-icon animate-pulse" />
          <div className="absolute inset-0 border-t-4 border-primary rounded-icon animate-spin" />
        </div>
      </div>
    );
  }

  const sidebarFeeds = feeds.map((f: any) => ({
    ...f,
    category: f.category?.name || t("uncategorized"),
    categoryHideFromAllFeeds: f.category?.hideFromAllFeeds ?? false,
    unreadCount: counts.byFeed[f.id] ?? 0,
    icon: f.icon || "📰",
  }));

  const selectedFeedData = feeds.find((f) => f.id === selectedArticle?.feedId);
  const hideArticleImage = selectedFeedData?.hideArticleImage ?? false;
  const effectiveReaderWidth = (selectedFeedData?.readerWidthOverride ?? readingPrefs?.readerWidth ?? "normal") as "normal" | "wide" | "full";
  const effectiveReaderFontSize = (selectedFeedData?.readerFontSizeOverride ?? readingPrefs?.readerFontSize ?? "medium") as "small" | "medium" | "large" | "xl";

  if (isMobileLayout === null) {
    return (
      <div className="h-dvh flex items-center justify-center bg-background">
        <div className="relative w-20 h-20">
          <div className="absolute inset-0 border-4 border-primary/20 rounded-icon animate-pulse" />
          <div className="absolute inset-0 border-t-4 border-primary rounded-icon animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div id="main-content" role="main" className="fixed inset-0 flex bg-background overflow-hidden selection:bg-accent/20 app-chrome">
      {/* A-2.1: Live region announces article count changes to screen readers */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {unreadCount} unread {unreadCount === 1 ? "article" : "articles"}
      </div>
      {/* Desktop Sidebar */}
      {!isMobileLayout && (
      <div className="shrink-0 w-80 overflow-hidden">
        <RssSidebar
          feeds={sidebarFeeds}
          selectedFeed={selectedFeed}
          selectedCategory={selectedCategory}
          defaultOpenAddFeed={openAddFeed}
          initialWebpageUrl={sharedWebpageUrl}
          hideEmptyFeeds={readingPrefs?.hideEmptyFeeds ?? false}
          hideEmptyLabels={readingPrefs?.hideEmptyLabels ?? false}
          onSelectFeed={handleSelectFeedNav}
          onSelectCategory={handleSelectCategoryNav}
        />
      </div>
      )}

      {/* Mobile feed picker: a Radix-based bottom sheet (NOT a vaul drawer).
          The sidebar hosts dialogs (Add feed) whose Radix content portals to
          <body>; nesting them inside a vaul drawer breaks text-input focus on
          iOS (tap shows the focus ring but no caret/keyboard). A Radix Sheet is
          itself a Radix Dialog, so the Add-feed dialog stacks as a normal
          nested Radix dialog and its inputs work. Trade-off vs. vaul: no
          drag-to-dismiss gesture (close via the X, tap-outside, or picking a
          feed). */}
      {isMobileLayout && (
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent
          side="bottom"
          // pt-12 reserves room for SheetContent's own built-in close button
          // (absolute top-4 end-4, ~44px tall) — without it, RssSidebar's own
          // header (search button top-right) renders directly underneath and
          // visually collides with it.
          className="h-[86dvh] rounded-t-sheet border-border/70 p-0 pt-12 gap-0 lg:hidden"
        >
          <SheetTitle className="sr-only">{t("feedNavigation")}</SheetTitle>
          <RssSidebar
            feeds={sidebarFeeds}
            selectedFeed={selectedFeed}
            selectedCategory={selectedCategory}
            defaultOpenAddFeed={openAddFeed}
            initialWebpageUrl={sharedWebpageUrl}
            hideEmptyFeeds={readingPrefs?.hideEmptyFeeds ?? false}
            hideEmptyLabels={readingPrefs?.hideEmptyLabels ?? false}
            onSelectFeed={(feedId) => {
              handleSelectFeedNav(feedId);
              setSidebarOpen(false);
            }}
            onSelectCategory={(category) => {
              handleSelectCategoryNav(category);
              setSidebarOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>
      )}

      {/* Desktop: resizable article list + reader */}
      {!isMobileLayout && (
      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={readerLayout}
        onLayoutChanged={onReaderLayoutChanged}
        className="hidden min-w-0 flex-1 lg:flex"
      >
        <ResizablePanel
          id="article-list"
          defaultSize="36%"
          minSize="20%"
          maxSize="70%"
        >
          <div role="region" aria-label={tA11y("articleList")} onPointerDownCapture={handleListPointerDown} className="relative z-(--z-sticky) flex h-full min-w-[320px] flex-col border-e border-border/60 bg-card/70 backdrop-blur-bar">
            {isSearchActive ? (
              <SearchResultsView
                searchQuery={searchQuery}
                articles={filteredArticles}
                selectedArticle={selectedArticle}
                isLoading={articlesLoading}
                unreadCount={unreadCount}
                onCloseSearch={handleCloseSearch}
                onEditSearch={handleEditSearch}
                onSaveSearch={handleSaveSearch}
                onSelectArticle={handleSelectArticle}
                onToggleRead={handleToggleRead}
                onToggleStar={handleToggleStar}
                onToggleReadLater={handleToggleReadLater}
                onMarkRead={(articleId) => {
                  const article = displayArticles.find((a: any) => a.id === articleId);
                  if (article) markArticleRead(article);
                }}
                markReadOnScroll={readingPrefs?.markReadOnScroll ?? false}
                filterKey={`search|${debouncedSearchQuery}|${sortOrder}`}
                transitionStyle={transitionStyle}
                hasMorePages={articleList.hasMore}
                isFetchingMore={articleList.isFetchingMore}
                onLoadMore={articleList.fetchMore}
                loadedCount={rawArticles.length}
              />
            ) : (
              <>
                <RssHeader
                  title={headerTitle}
                  articleCount={filteredArticles.length}
                  unreadCount={unreadCount}
                  viewMode={viewMode}
                  onViewModeChange={setViewMode}
                  onToggleSidebar={() => setSidebarOpen(true)}
                  onRefresh={handleRefresh}
                  isRefreshing={articlesLoading || refresh.isPending}
                  unreadOnly={unreadOnly}
                  onToggleUnreadOnly={toggleUnreadOnly}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onMarkAllRead={canMarkAllRead ? handleMarkAllRead : undefined}
                  isMarkingAllRead={isMarkingAllRead}
                  onSaveSearch={handleSaveSearch}
                  onShowShortcuts={() => setShortcutsOpen(true)}
                  sortOrder={sortOrder}
                  onToggleSort={handleToggleSort}
                />
                {!online && (
                  <div className="flex justify-center border-b border-border/60 px-4 py-2">
                    <OfflineChip />
                  </div>
                )}
                {isSpoilerCategory && !spoilerRevealed ? spoilerGate : (
                  <ArticleList
                    articles={filteredArticles}
                    selectedArticle={selectedArticle}
                    onSelectArticle={handleSelectArticle}
                    onToggleRead={handleToggleRead}
                    onToggleStar={handleToggleStar}
                    onToggleReadLater={handleToggleReadLater}
                    onReleaseSpoiler={isSpoilerCategory ? (articleId) => releaseArticleSpoiler.mutate(articleId) : undefined}
                    viewMode={viewMode}
                    isLoading={articlesLoading}
                    markReadOnScroll={readingPrefs?.markReadOnScroll ?? false}
                    filterKey={`${unreadOnly ? "unread" : "all"}|${selectedFeed ?? "_"}|${selectedCategory}|${sortOrder}`}
                    transitionStyle={transitionStyle}
                    onMarkRead={(articleId) => {
                      const article = displayArticles.find((a: any) => a.id === articleId);
                      if (article) markArticleRead(article);
                    }}
                    endOfList={endOfListCard}
                    scrollBackToId={lastClosedArticleId}
                    hasFeeds={feeds.length > 0}
                    hasMorePages={articleList.hasMore}
                    isFetchingMore={articleList.isFetchingMore}
                    onLoadMore={articleList.fetchMore}
                    loadedCount={rawArticles.length}
                  />
                )}
              </>
            )}
          </div>
        </ResizablePanel>

        <ResizableHandle
          withHandle
          className="bg-border/40 transition-colors hover:bg-accent/35"
        />

        <ResizablePanel id="article-reader" defaultSize="64%" minSize="30%">
          <div role="region" aria-label={tA11y("articleReader")} className="flex h-full bg-background">
            <ArticleReader
              article={readerArticle}
              isBodyLoading={isReaderBodyLoading}
              onToggleStar={handleToggleStar}
              onToggleReadLater={handleToggleReadLater}
              onToggleRead={handleToggleRead}
              onFetchFullText={handleFetchFullText}
              isFetchingFullText={isFetchingFullText}
              labels={labels}
              onSetLabels={handleSetLabels}
              onBack={handleCloseArticle}
              onOpenFeed={handleOpenArticleFeed}
              showBackButton={!!selectedArticle}
              onPreviousArticle={() => handleSelectAdjacentArticle(-1)}
              onNextArticle={() => handleSelectAdjacentArticle(1)}
              hasPreviousArticle={selectedArticleIndex > 0}
              hasNextArticle={selectedArticleIndex >= 0 && selectedArticleIndex < filteredArticles.length - 1}
              readerWidth={effectiveReaderWidth}
              readerFontSize={effectiveReaderFontSize}
              hideArticleImage={hideArticleImage}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      )}

      {/* Mobile Article List Panel */}
      {isMobileLayout && !selectedArticle && (
      <div role="region" aria-label={tA11y("articleList")} onPointerDownCapture={handleListPointerDown} className="relative z-(--z-sticky) flex min-w-0 flex-1 flex-col bg-card/70 backdrop-blur-bar transition-all duration-(--dur-slow) ease-out">
        {isSearchActive ? (
          <SearchResultsView
            searchQuery={searchQuery}
            articles={filteredArticles}
            selectedArticle={selectedArticle}
            isLoading={articlesLoading}
            unreadCount={unreadCount}
            onCloseSearch={handleCloseSearch}
            onEditSearch={handleEditSearch}
            onSaveSearch={handleSaveSearch}
            onSelectArticle={handleSelectArticle}
            onToggleRead={handleToggleRead}
            onToggleStar={handleToggleStar}
            onToggleReadLater={handleToggleReadLater}
            onMarkRead={(articleId) => {
              const article = displayArticles.find((a: any) => a.id === articleId);
              if (article) markArticleRead(article);
            }}
            markReadOnScroll={readingPrefs?.markReadOnScroll ?? false}
            filterKey={`search|${debouncedSearchQuery}|${sortOrder}`}
            transitionStyle={transitionStyle}
            hasMorePages={articleList.hasMore}
            isFetchingMore={articleList.isFetchingMore}
            onLoadMore={articleList.fetchMore}
            loadedCount={rawArticles.length}
            isMobile
          />
        ) : (
          <>
            <RssHeader
              title={headerTitle}
              articleCount={filteredArticles.length}
              unreadCount={unreadCount}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              onToggleSidebar={() => setSidebarOpen(true)}
              onRefresh={handleRefresh}
              isRefreshing={articlesLoading || refresh.isPending}
              unreadOnly={unreadOnly}
              onToggleUnreadOnly={toggleUnreadOnly}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              onMarkAllRead={canMarkAllRead ? handleMarkAllRead : undefined}
              isMarkingAllRead={isMarkingAllRead}
              onSaveSearch={handleSaveSearch}
              onShowShortcuts={() => setShortcutsOpen(true)}
              sortOrder={sortOrder}
              onToggleSort={handleToggleSort}
            />
            {!online && (
              <div className="flex justify-center border-b border-border/60 px-4 py-2">
                <OfflineChip />
              </div>
            )}
            {isSpoilerCategory && !spoilerRevealed ? spoilerGate : (
              <ArticleList
                articles={filteredArticles}
                selectedArticle={selectedArticle}
                onSelectArticle={handleSelectArticle}
                onToggleRead={handleToggleRead}
                onToggleStar={handleToggleStar}
                onToggleReadLater={handleToggleReadLater}
                onReleaseSpoiler={isSpoilerCategory ? (articleId) => releaseArticleSpoiler.mutate(articleId) : undefined}
                viewMode={viewMode}
                isLoading={articlesLoading}
                markReadOnScroll={readingPrefs?.markReadOnScroll ?? false}
                filterKey={`${unreadOnly ? "unread" : "all"}|${selectedFeed ?? "_"}|${selectedCategory}|${sortOrder}`}
                transitionStyle={transitionStyle}
                onMarkRead={(articleId) => {
                  const article = displayArticles.find((a: any) => a.id === articleId);
                  if (article) markArticleRead(article);
                }}
                enablePullToRefresh
                isRefreshing={articlesLoading || refresh.isPending}
                onPullToRefresh={handleRefresh}
                endOfList={endOfListCard}
                scrollBackToId={lastClosedArticleId}
                hasFeeds={feeds.length > 0}
                hasMorePages={articleList.hasMore}
                isFetchingMore={articleList.isFetchingMore}
                onLoadMore={articleList.fetchMore}
                loadedCount={rawArticles.length}
              />
            )}
          </>
        )}
        <MobileBottomControls
          unreadOnly={unreadOnly}
          onToggleUnreadOnly={toggleUnreadOnly}
          onToggleSidebar={() => setSidebarOpen(true)}
          sidebarOpen={sidebarOpen}
          onRefresh={handleRefresh}
          isRefreshing={articlesLoading || refresh.isPending}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onMarkAllRead={canMarkAllRead ? handleMarkAllRead : undefined}
          isMarkingAllRead={isMarkingAllRead}
          isSearchActive={isSearchActive}
          onCloseSearch={handleCloseSearch}
          onEditSearch={handleEditSearch}
        />
      </div>
      )}

      {/* Mobile Article Reader Panel */}
      {isMobileLayout && (selectedArticle || isClosingReader) && (
      <div role="region" aria-label={tA11y("articleReader")} className={`fixed inset-0 z-(--z-overlay) flex bg-background ${isClosingReader ? "animate-slide-out-right" : "animate-slide-in-right"}`}>
        <ArticleReader
          article={readerArticle}
          isBodyLoading={isReaderBodyLoading}
          onToggleStar={handleToggleStar}
          onToggleReadLater={handleToggleReadLater}
          onToggleRead={handleToggleRead}
          onFetchFullText={handleFetchFullText}
          isFetchingFullText={isFetchingFullText}
          labels={labels}
          onSetLabels={handleSetLabels}
          onBack={handleMobileBack}
          onOpenFeed={handleOpenArticleFeed}
          showBackButton={!!selectedArticle}
          onPreviousArticle={() => handleSelectAdjacentArticle(-1)}
          onNextArticle={() => handleSelectAdjacentArticle(1)}
          hasPreviousArticle={selectedArticleIndex > 0}
          hasNextArticle={selectedArticleIndex >= 0 && selectedArticleIndex < filteredArticles.length - 1}
          readerWidth={effectiveReaderWidth}
          readerFontSize={effectiveReaderFontSize}
          hideArticleImage={hideArticleImage}
        />
      </div>
      )}

      {/* Search modal */}
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-xl rounded-2xl border-border/60 bg-card/95 backdrop-blur-bar shadow-overlay p-0 gap-0 overflow-hidden"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t("searchArticles")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (searchQuery.trim()) {
                setSearchOpen(false);
                setSidebarOpen(false);
              }
            }}
          >
            <div className="flex items-center gap-3 px-5 pt-5 pb-3 border-b border-border/50">
              <SearchIcon className="w-5 h-5 text-muted-foreground shrink-0" />
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={tSearch("searchPlaceholder")}
                className="border-0 bg-transparent text-base sm:text-lg font-medium focus-visible:ring-0 focus-visible:ring-offset-0 px-2 h-12 py-0 placeholder:text-muted-foreground/70"
                autoFocus
                enterKeyHint="search"
              />
              <button
                type="button"
                onClick={() => {
                  if (searchQuery) {
                    setSearchQuery("");
                  } else {
                    setSearchOpen(false);
                  }
                }}
                aria-label={searchQuery ? tA11y("clearSearch") : tA11y("closeSearch")}
                className="flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
              >
                <XIcon className="w-5 h-5" />
              </button>
            </div>
            <div className="px-5 py-3 text-xs text-muted-foreground">
              {searchQuery.trim()
                ? `${tSearch("matchesAcrossFeeds", { count: filteredArticles.length })} (${tSearch("unreadCount", { count: filteredArticles.filter((a: any) => !a.isRead).length })})`
                : tSearch("globalSearchHint")}
            </div>
            <div className="flex flex-col gap-2 px-4 pb-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setSearchOpen(false)}
                className="order-2 sm:order-1 rounded-xl border border-border/60 bg-background/60 px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                {tSearch("cancel")}
              </button>
              <button
                type="submit"
                disabled={!searchQuery.trim()}
                className="order-1 sm:order-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm active:scale-[0.98] transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {searchQuery.trim()
                  ? tSearch("showResults", { count: filteredArticles.length })
                  : tSearch("enterSearchTerm")}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
      />

      <CommandPalette
        feeds={feeds}
        categories={categories}
        labels={labels}
        onRefresh={handleRefresh}
        onMarkAllRead={canMarkAllRead ? handleMarkAllRead : undefined}
        onFocusSearch={handleEditSearch}
        onAddFeed={handleOpenAddFeed}
        onOpenSettings={handleOpenSettings}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onSelectFeed={handleSelectFeedNav}
        onSelectCategory={handleSelectCategoryNav}
        onSelectLabel={handleSelectLabelNav}
      />
    </div>
  );
}
