"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import readingTime from "reading-time";
import { RssSidebar } from "@/components/rss-sidebar";
import { ArticleList } from "@/components/article-list";
import { ArticleReader } from "@/components/article-reader";
import { RssHeader, ViewMode } from "@/components/rss-header";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { MobileBottomControls } from "@/components/mobile-bottom-controls";
import {
  useFeeds,
  useArticles,
  useToggleRead,
  useToggleStarred,
  useToggleReadLater,
  useRefresh,
  useMarkAllAsRead,
  useFetchFullText,
  useLabels,
  useSavedSearches,
  useCreateSavedSearch,
  useSetArticleLabels,
  useReadingPreferences,
  useUpdateGlobalSettings,
  useReleaseArticleSpoiler,
  useReleaseAllSpoilers,
} from "@/hooks/use-rss-data";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Search as SearchIcon, X as XIcon } from "lucide-react";
import { SpoilerIcon } from "@/components/icons/spoiler-icon";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { hasUsers } from "./actions/onboarding";
import { useRouter } from "next/navigation";
import { useAppBadge, useUnreadBadgeCount } from "@/hooks/use-app-badge";
import { useOfflineArticleCache } from "@/hooks/use-offline-articles";

function toUiArticle(a: any) {
  const publishedAt = new Date(a.publishedAt);
  return {
    ...a,
    feedName: a.feed.name,
    feedIcon: a.feed.icon || "",
    publishedAtRaw: publishedAt.getTime(),
    publishedAt: publishedAt.toISOString(),
    readTime: readingTime((a.content || "").replace(/<[^>]*>?/gm, "")).text,
    excerpt: a.excerpt || "",
    author: a.author || "Unknown",
    duplicateCount: a._count?.duplicates ?? 0,
    canonicalFeedName: a.canonical?.feed?.name ?? null,
  };
}

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
  const [openAddFeed, setOpenAddFeed] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState<boolean | null>(null);
  const [isClosingReader, setIsClosingReader] = useState(false);
  const isAuthenticated = status === "authenticated";

  const { data: feeds = [], isLoading: feedsLoading } = useFeeds(isAuthenticated);
  const isSearchActive = Boolean(searchQuery.trim());
  const { data: rawArticles = [], isLoading: articlesLoading } = useArticles(
    isSearchActive ? null : selectedFeed,
    isSearchActive ? "All Articles" : selectedCategory,
    searchQuery || undefined,
    isAuthenticated,
  );

  const refresh = useRefresh();
  const toggleRead = useToggleRead();
  const toggleStarred = useToggleStarred();
  const toggleReadLater = useToggleReadLater();
  const markAllAsRead = useMarkAllAsRead();
  const fetchFullText = useFetchFullText();
  const { data: labels = [] } = useLabels(isAuthenticated);
  const { data: savedSearches = [] } = useSavedSearches(isAuthenticated);
  const createSavedSearch = useCreateSavedSearch();
  const setArticleLabels = useSetArticleLabels();
  const { data: readingPrefs } = useReadingPreferences(isAuthenticated);
  const updateGlobalSettings = useUpdateGlobalSettings();
  const releaseArticleSpoiler = useReleaseArticleSpoiler();
  const releaseAllSpoilers = useReleaseAllSpoilers();

  const unreadBadgeCount = useUnreadBadgeCount(feeds);
  useAppBadge(unreadBadgeCount, status === "authenticated");

  const [readInSession, setReadInSession] = useState<string[]>([]);
  const [autoReadSuppressedArticles, setAutoReadSuppressedArticles] = useState<string[]>([]);
  const [sessionReadArticles, setSessionReadArticles] = useState<any[]>([]);
  const [selectedArticleSnapshot, setSelectedArticleSnapshot] = useState<any | null>(null);
  const [lastClosedArticleId, setLastClosedArticleId] = useState<string | null>(null);
  const deepLinkAppliedRef = useRef(false);
  const articleDeepLinkRef = useRef<string | null>(null);

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
    setSessionReadArticles([]);
    setSelectedArticleSnapshot(null);
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
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500">
          <SpoilerIcon className="h-8 w-8" />
        </div>
        <div className="space-y-2">
          <h3 className="text-xl font-semibold tracking-tight">Spoiler content ahead</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            These articles have been flagged by your rules as spoilers and are kept out of every
            other view on purpose. Reveal only when you&apos;re ready to see them.
          </p>
        </div>
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => setSpoilerRevealed(true)}
            className="rounded-2xl bg-amber-500 px-6 py-3 text-sm font-semibold text-amber-50 shadow-sm hover:bg-amber-600 active:scale-[0.98] transition-all"
          >
            Reveal spoilers
          </button>
          <button
            type="button"
            onClick={() => {
              releaseAllSpoilers.mutate(undefined, {
                onSuccess: () => { setSelectedCategory("All"); setSelectedFeed(null); },
              });
            }}
            disabled={releaseAllSpoilers.isPending}
            className="text-xs text-amber-600 hover:text-amber-700 disabled:opacity-50"
          >
            {releaseAllSpoilers.isPending ? "Clearing…" : "Clear all spoiler flags"}
          </button>
          <button
            type="button"
            onClick={() => { setSelectedCategory("All"); setSelectedFeed(null); }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Take me back
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
      setOpenAddFeed(true);
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
      }).then(() => {
        if (typeof window !== "undefined") {
          localStorage.setItem("lastSync", new Date().toISOString());
        }
      }).catch(console.error);
    }
  }, [isAuthenticated]);

  const { articles: cachedRawArticles, isOffline, hasOfflineSnapshot } = useOfflineArticleCache(rawArticles);

  // Transform articles for UI components
  const articles = useMemo(() => {
    return cachedRawArticles.map(toUiArticle);
  }, [cachedRawArticles]);

  const displayArticles = useMemo(() => {
    const byId = new Map<string, any>();
    [...articles, ...sessionReadArticles].forEach((article) => {
      const previous = byId.get(article.id);
      byId.set(article.id, previous ? { ...previous, ...article } : article);
    });
    return Array.from(byId.values());
  }, [articles, sessionReadArticles]);

  const selectedArticle = useMemo(
    () => selectedArticleId
      ? displayArticles.find((a: any) => a.id === selectedArticleId) || selectedArticleSnapshot
      : null,
    [displayArticles, selectedArticleId, selectedArticleSnapshot],
  );

  const unreadCount = useMemo(
    () => displayArticles.filter((a: any) => !a.isRead).length,
    [displayArticles],
  );

  useEffect(() => {
    const articleId = articleDeepLinkRef.current;
    if (!articleId || selectedArticleId) return;
    const article = displayArticles.find((item: any) => item.id === articleId);
    if (!article) return;
    setSelectedArticleId(article.id);
    setSelectedArticleSnapshot(article);
    articleDeepLinkRef.current = null;
  }, [displayArticles, selectedArticleId]);


  const filteredArticles = useMemo(() => {
    let list = [...displayArticles];

    // Apply main view filter - include items that are either:
    // 1. Not yet read, OR
    // 2. Read in this session (clicked but still visible), OR
    // 3. Already in readInSession (persist visibility after server update)
    // Global search bypasses unreadOnly so all matches show.
    if (unreadOnly && !isSearchActive) {
      list = list.filter((a) => !a.isRead || readInSession.includes(a.id));
    }

    // Sort AFTER filtering
    return list.sort((a: any, b: any) =>
      sortOrder === "oldest" ? a.publishedAtRaw - b.publishedAtRaw : b.publishedAtRaw - a.publishedAtRaw,
    );
  }, [displayArticles, unreadOnly, readInSession, sortOrder, isSearchActive]);

  const selectedArticleIndex = useMemo(
    () => filteredArticles.findIndex((article: any) => article.id === selectedArticleId),
    [filteredArticles, selectedArticleId],
  );

  const headerTitle = useMemo(() => {
    if (selectedFeed) {
      return feeds.find((f: any) => f.id === selectedFeed)?.name || "Feed";
    }
    if (selectedCategory.startsWith("Label:")) {
      return labels.find((label: any) => label.id === selectedCategory.slice("Label:".length))?.name || "Label";
    }
    if (selectedCategory.startsWith("Search:")) {
      return savedSearches.find((search: any) => search.id === selectedCategory.slice("Search:".length))?.name || "Saved Search";
    }
    return selectedCategory;
  }, [selectedFeed, selectedCategory, feeds, labels, savedSearches]);

  const markArticleRead = useCallback((article: any) => {
    if (
      !article ||
      article.isRead ||
      readInSession.includes(article.id) ||
      autoReadSuppressedArticles.includes(article.id)
    ) return;
      const readArticle = { ...article, isRead: true, readAt: new Date() };
      setReadInSession((prev) => [...prev, article.id]);
      setAutoReadSuppressedArticles((prev) => prev.filter((id) => id !== article.id));
      setSessionReadArticles((prev) => [
        readArticle,
        ...prev.filter((a) => a.id !== article.id),
      ]);
      setSelectedArticleSnapshot(readArticle);
      toggleRead.mutate({ articleId: article.id, isRead: true });
  }, [autoReadSuppressedArticles, readInSession, toggleRead]);

  const handleSelectArticle = useCallback((article: any) => {
    setSelectedArticleId(article.id);
    setSelectedArticleSnapshot(article);
    if (readingPrefs?.openOriginalByDefault && article.link) {
      window.open(article.link, "_blank", "noopener,noreferrer");
    }
  }, [readingPrefs?.openOriginalByDefault]);

  const handleCloseArticle = useCallback(() => {
    setLastClosedArticleId(selectedArticleIdRef.current);
    setSelectedArticleId(null);
    setSelectedArticleSnapshot(null);
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
    setSelectedArticleSnapshot(null);
    setSidebarOpen(false);
  }, []);

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

  const handleToggleRead = useCallback((articleId: string) => {
    const article = displayArticles.find((a: any) => a.id === articleId) || selectedArticleSnapshot;
    if (!article) return;
    const nextIsRead = !article.isRead;
    const updated = { ...article, isRead: nextIsRead, readAt: nextIsRead ? new Date() : null };

    setSessionReadArticles((prev) => {
      const without = prev.filter((a) => a.id !== articleId);
      return unreadOnly || !nextIsRead
        ? [updated, ...without]
        : without;
    });
    setReadInSession((prev) =>
      nextIsRead ? Array.from(new Set([...prev, articleId])) : prev.filter((id) => id !== articleId),
    );
    setAutoReadSuppressedArticles((prev) => {
      if (nextIsRead) return prev.filter((id) => id !== articleId);
      if (selectedArticleId !== articleId) return prev;
      return Array.from(new Set([...prev, articleId]));
    });
    if (selectedArticleId === articleId) setSelectedArticleSnapshot(updated);
    toggleRead.mutate({ articleId, isRead: nextIsRead });
  }, [displayArticles, selectedArticleSnapshot, unreadOnly, selectedArticleId, toggleRead]);

  const handleToggleStar = useCallback((articleId: string) => {
    const article = displayArticles.find((a: any) => a.id === articleId) || selectedArticleSnapshot;
    if (article) {
      toggleStarred.mutate({ articleId, isStarred: !article.isStarred });
      const updated = { ...article, isStarred: !article.isStarred };
      if (selectedArticleId === articleId) setSelectedArticleSnapshot(updated);
      setSessionReadArticles((prev) => prev.map((a) => a.id === articleId ? updated : a));
    }
  }, [displayArticles, selectedArticleSnapshot, selectedArticleId, toggleStarred]);

  const handleToggleReadLater = useCallback((articleId: string) => {
    const article = displayArticles.find((a: any) => a.id === articleId) || selectedArticleSnapshot;
    if (article) {
      const next = !article.isReadLater;
      toggleReadLater.mutate({ articleId, isReadLater: next });
      const updated = { ...article, isReadLater: next, readLaterSavedAt: next ? new Date() : null };
      if (selectedArticleId === articleId) setSelectedArticleSnapshot(updated);
      setSessionReadArticles((prev) => prev.map((a) => a.id === articleId ? updated : a));
    }
  }, [displayArticles, selectedArticleSnapshot, selectedArticleId, toggleReadLater]);

  const handleRefresh = useCallback(() => {
    refresh.mutate();
  }, [refresh]);

  const handleMarkAllRead = useCallback(() => {
    const feedsList = feeds as any[];
    markAllAsRead.mutate(
      { feedId: selectedFeed, category: selectedFeed ? null : selectedCategory },
      {
        onSuccess: () => {
          if (!selectedFeed) return;
          const currentIdx = feedsList.findIndex((f) => f.id === selectedFeed);
          if (currentIdx === -1) return;
          const ordered = [
            ...feedsList.slice(currentIdx + 1),
            ...feedsList.slice(0, currentIdx),
          ];
          const nextFeed = ordered.find((f) => (f._count?.articles ?? 0) > 0);
          setSelectedArticleId(null);
          setSelectedArticleSnapshot(null);
          setTransitionStyle("flip");
          if (nextFeed) {
            setSelectedFeed(nextFeed.id);
            setSelectedCategory("All");
            setUnreadOnly(true);
          } else {
            // No more unread anywhere — fall back to the global Unread view
            setSelectedFeed(null);
            setSelectedCategory("All Articles");
            setUnreadOnly(true);
          }
        },
      },
    );
  }, [feeds, markAllAsRead, selectedFeed, selectedCategory]);

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

  const navigateFeed = useCallback((direction: 1 | -1) => {
    const feedsList = feeds as any[];
    if (feedsList.length === 0) return;
    if (!selectedFeed) {
      const target = direction === 1 ? feedsList[0] : feedsList[feedsList.length - 1];
      if (target) {
        setSelectedFeed(target.id);
        setSelectedCategory("All");
        setSelectedArticleId(null);
        setSelectedArticleSnapshot(null);
      }
      return;
    }
    const idx = feedsList.findIndex((f) => f.id === selectedFeed);
    if (idx === -1) return;
    const next = feedsList[(idx + direction + feedsList.length) % feedsList.length];
    if (next && next.id !== selectedFeed) {
      // Auto-mark all articles in the current feed as read when swiping forward
      if (direction === 1) {
        markAllAsRead.mutate({ feedId: selectedFeed, category: null });
      }
      setSelectedFeed(next.id);
      setSelectedCategory("All");
      setSelectedArticleId(null);
      setSelectedArticleSnapshot(null);
    }
  }, [feeds, selectedFeed, markAllAsRead]);

  const handleToggleSort = useCallback(() => {
    setSortOrder((prev) => {
      const next = prev === "newest" ? "oldest" : "newest";
      updateGlobalSettings.mutate({ defaultArticleSort: next });
      return next;
    });
  }, [updateGlobalSettings]);

  const handleFetchFullText = useCallback((articleId: string) => {
    fetchFullText.mutate(articleId, {
      onSuccess: (article: any) => {
        const uiArticle = toUiArticle(article);
        setSelectedArticleSnapshot(uiArticle);
        setSessionReadArticles((prev) => [
          uiArticle,
          ...prev.filter((a) => a.id !== uiArticle.id),
        ]);
      },
    });
  }, [fetchFullText]);

  const handleSetLabels = useCallback((articleId: string, labelIds: string[]) => {
    setArticleLabels.mutate({ articleId, labelIds }, {
      onSuccess: (article: any) => {
        const uiArticle = toUiArticle(article);
        setSelectedArticleSnapshot(uiArticle);
        setSessionReadArticles((prev) => [
          uiArticle,
          ...prev.filter((a) => a.id !== uiArticle.id),
        ]);
      },
    });
  }, [setArticleLabels]);

  const handleSaveSearch = useCallback(() => {
    const query = searchQuery.trim();
    if (!query) return;
    const name = window.prompt("Name for this saved search", query.length > 40 ? `${query.slice(0, 40)}…` : query);
    if (!name?.trim()) return;
    createSavedSearch.mutate({ name: name.trim(), query });
  }, [createSavedSearch, searchQuery]);

  // Use refs for keyboard navigation to avoid stale closures
  const filteredArticlesRef = useRef(filteredArticles);
  const selectedArticleIdRef = useRef(selectedArticleId);
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
    } else if (e.key === "o" && selectedArticleSnapshot?.link) {
      window.open(selectedArticleSnapshot.link, "_blank", "noopener,noreferrer");
    } else if (e.key === "r") {
      handleRefresh();
    } else if (e.key === "A" && e.shiftKey) {
      e.preventDefault();
      handleMarkAllRead();
    } else if (e.key === "S" && e.shiftKey) {
      e.preventDefault();
      handleSaveSearch();
    }
  }, [handleSelectArticle, handleToggleStar, handleToggleReadLater, handleToggleRead, handleRefresh, handleMarkAllRead, selectedArticleSnapshot, handleSaveSearch]);

  useEffect(() => {
    async function checkSetup() {
      if (status === "unauthenticated") {
        const hasExistingUsers = await hasUsers();
        if (!hasExistingUsers) {
          router.push("/setup");
        }
      }
    }
    checkSetup();
  }, [status, router]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [handleKeyDown]);

  if (status === "loading") {
    return (
      <div className="h-dvh flex items-center justify-center bg-[#05060a]">
        <div className="relative w-20 h-20">
          <div className="absolute inset-0 border-4 border-primary/20 rounded-[28%] animate-pulse" />
          <div className="absolute inset-0 border-t-4 border-primary rounded-[28%] animate-spin" />
        </div>
      </div>
    );
  }

  const sidebarFeeds = feeds.map((f: any) => ({
    ...f,
    category: f.category?.name || "Uncategorized",
    unreadCount: f._count?.articles || 0,
    icon: f.icon || "📰",
  }));

  const selectedFeedData = (feeds as any[]).find((f: any) => f.id === selectedArticle?.feedId);
  const hideArticleImage = selectedFeedData?.hideArticleImage ?? false;

  if (isMobileLayout === null) {
    return (
      <div className="h-dvh flex items-center justify-center bg-[#05060a]">
        <div className="relative w-20 h-20">
          <div className="absolute inset-0 border-4 border-primary/20 rounded-[28%] animate-pulse" />
          <div className="absolute inset-0 border-t-4 border-primary rounded-[28%] animate-spin" />
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
          onSelectFeed={(feedId) => {
            setSelectedFeed(feedId);
            setSelectedArticleId(null);
            setSelectedArticleSnapshot(null);
            if (feedId) {
              setSelectedCategory("All");
              setUnreadOnly(true);
            }
          }}
          onSelectCategory={(cat) => {
            setSelectedCategory(cat);
            setSelectedFeed(null);
            setSelectedArticleId(null);
            setSelectedArticleSnapshot(null);
            const noUnreadFilter = cat === "Starred" || cat === "Read Later";
            setUnreadOnly(!noUnreadFilter);
          }}
        />
      </div>
      )}

      {/* Mobile feed picker: bottom drawer keeps navigation in thumb reach. */}
      {isMobileLayout && (
      <Drawer open={sidebarOpen} onOpenChange={setSidebarOpen} direction="bottom">
        <DrawerContent className="h-[86dvh] rounded-t-[2rem] border-border/70 p-0 lg:hidden">
          <RssSidebar
            feeds={sidebarFeeds}
            selectedFeed={selectedFeed}
            selectedCategory={selectedCategory}
            defaultOpenAddFeed={openAddFeed}
            onSelectFeed={(feedId) => {
              setSelectedFeed(feedId);
              setSelectedArticleId(null);
              setSelectedArticleSnapshot(null);
              if (feedId) {
                setSelectedCategory("All");
                setUnreadOnly(true);
              }
              setSidebarOpen(false);
            }}
            onSelectCategory={(category) => {
              setSelectedCategory(category);
              setSelectedFeed(null);
              setSelectedArticleId(null);
              setSelectedArticleSnapshot(null);
              const noUnreadFilter = category === "Starred" || category === "Read Later";
              setUnreadOnly(!noUnreadFilter);
              setSidebarOpen(false);
            }}
          />
        </DrawerContent>
      </Drawer>
      )}

      {/* Desktop: resizable article list + reader */}
      {!isMobileLayout && (
      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId="feedferret-reader-layout"
        className="hidden min-w-0 flex-1 lg:flex"
      >
        <ResizablePanel
          defaultSize={36}
          minSize={26}
          maxSize={55}
          className="min-w-[360px]"
        >
          <div role="region" aria-label="Article list" className="relative z-10 flex h-full flex-col border-r border-border/60 bg-card/70 backdrop-blur-2xl">
            <RssHeader
              title={searchQuery ? `Search: "${searchQuery}"` : headerTitle}
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
              onMarkAllRead={handleMarkAllRead}
              isMarkingAllRead={markAllAsRead.isPending}
              onSaveSearch={handleSaveSearch}
              onShowShortcuts={() => setShortcutsOpen(true)}
              sortOrder={sortOrder}
              onToggleSort={handleToggleSort}
              onSwipeNextFeed={() => navigateFeed(1)}
              onSwipePreviousFeed={() => navigateFeed(-1)}
            />
            {isOffline && hasOfflineSnapshot && (
              <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-200">
                Offline mode: showing cached articles from this device.
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
                onOverscrollPastEnd={() => navigateFeed(1)}
                onOverscrollPastTop={() => navigateFeed(-1)}
                onSwipeNextFeed={() => navigateFeed(1)}
                onSwipePreviousFeed={() => navigateFeed(-1)}
                scrollBackToId={lastClosedArticleId}
              />
            )}
          </div>
        </ResizablePanel>

        <ResizableHandle
          withHandle
          className="bg-border/40 transition-colors hover:bg-accent/35"
        />

        <ResizablePanel defaultSize={64} minSize={45}>
          <div role="region" aria-label="Article reader" className="flex h-full bg-background">
            <ArticleReader
              article={selectedArticle}
              onToggleStar={handleToggleStar}
              onToggleReadLater={handleToggleReadLater}
              onToggleRead={handleToggleRead}
              onFetchFullText={handleFetchFullText}
              isFetchingFullText={fetchFullText.isPending}
              labels={labels}
              onSetLabels={handleSetLabels}
              onBack={handleCloseArticle}
              onOpenFeed={handleOpenArticleFeed}
              showBackButton={!!selectedArticle}
              onPreviousArticle={() => handleSelectAdjacentArticle(-1)}
              onNextArticle={() => handleSelectAdjacentArticle(1)}
              hasPreviousArticle={selectedArticleIndex > 0}
              hasNextArticle={selectedArticleIndex >= 0 && selectedArticleIndex < filteredArticles.length - 1}
              readerWidth={(readingPrefs?.readerWidth ?? "normal") as "normal" | "wide" | "full"}
              readerFontSize={(readingPrefs?.readerFontSize ?? "medium") as "small" | "medium" | "large" | "xl"}
              hideArticleImage={hideArticleImage}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      )}

      {/* Mobile Article List Panel */}
      {isMobileLayout && !selectedArticle && (
      <div role="region" aria-label="Article list" className="relative z-10 flex min-w-0 flex-1 flex-col bg-card/70 backdrop-blur-2xl transition-all duration-300 ease-out">
        <RssHeader
          title={searchQuery ? `Search: "${searchQuery}"` : headerTitle}
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
          onMarkAllRead={handleMarkAllRead}
          isMarkingAllRead={markAllAsRead.isPending}
          onSaveSearch={handleSaveSearch}
          onShowShortcuts={() => setShortcutsOpen(true)}
          sortOrder={sortOrder}
          onToggleSort={handleToggleSort}
          onSwipeNextFeed={() => navigateFeed(1)}
          onSwipePreviousFeed={() => navigateFeed(-1)}
        />
        {isOffline && hasOfflineSnapshot && (
          <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-200">
            Offline mode: showing cached articles from this device.
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
            onOverscrollPastEnd={() => navigateFeed(1)}
            onOverscrollPastTop={() => navigateFeed(-1)}
            onSwipeNextFeed={() => navigateFeed(1)}
            onSwipePreviousFeed={() => navigateFeed(-1)}
            scrollBackToId={lastClosedArticleId}
          />
        )}
        <MobileBottomControls
          unreadOnly={unreadOnly}
          onToggleUnreadOnly={toggleUnreadOnly}
          onToggleSidebar={() => setSidebarOpen(true)}
          onRefresh={handleRefresh}
          isRefreshing={articlesLoading || refresh.isPending}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onMarkAllRead={handleMarkAllRead}
          isMarkingAllRead={markAllAsRead.isPending}
        />
      </div>
      )}

      {/* Mobile Article Reader Panel */}
      {isMobileLayout && (selectedArticle || isClosingReader) && (
      <div role="region" aria-label="Article reader" className={`fixed inset-0 z-50 flex bg-background ${isClosingReader ? "animate-slide-out-right" : "animate-slide-in-right"}`}>
        <ArticleReader
          article={selectedArticle}
          onToggleStar={handleToggleStar}
          onToggleReadLater={handleToggleReadLater}
          onToggleRead={handleToggleRead}
          onFetchFullText={handleFetchFullText}
          isFetchingFullText={fetchFullText.isPending}
          labels={labels}
          onSetLabels={handleSetLabels}
          onBack={handleMobileBack}
          onOpenFeed={handleOpenArticleFeed}
          showBackButton={!!selectedArticle}
          onPreviousArticle={() => handleSelectAdjacentArticle(-1)}
          onNextArticle={() => handleSelectAdjacentArticle(1)}
          hasPreviousArticle={selectedArticleIndex > 0}
          hasNextArticle={selectedArticleIndex >= 0 && selectedArticleIndex < filteredArticles.length - 1}
          readerWidth={(readingPrefs?.readerWidth ?? "normal") as "normal" | "wide" | "full"}
          hideArticleImage={hideArticleImage}
        />
      </div>
      )}

      {/* Search modal */}
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-xl rounded-2xl border-border/60 bg-card/95 backdrop-blur-2xl shadow-2xl p-0 gap-0 overflow-hidden"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Search articles</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (searchQuery.trim()) setSearchOpen(false);
            }}
          >
            <div className="flex items-center gap-3 px-5 pt-5 pb-3 border-b border-border/50">
              <SearchIcon className="w-5 h-5 text-muted-foreground shrink-0" />
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Enter search term — try author:, intitle:, is:unread, label:"
                className="border-0 bg-transparent text-base sm:text-lg font-medium focus-visible:ring-0 focus-visible:ring-offset-0 px-0 h-12 py-0 placeholder:text-muted-foreground/70"
                // eslint-disable-next-line jsx-a11y/no-autofocus
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
                aria-label={searchQuery ? "Clear search" : "Close search"}
                className="flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
              >
                <XIcon className="w-5 h-5" />
              </button>
            </div>
            <div className="px-5 py-3 text-xs text-muted-foreground">
              {searchQuery.trim()
                ? `${filteredArticles.length} matches across all feeds (${filteredArticles.filter((a: any) => !a.isRead).length} unread)`
                : "Search runs globally across every feed. Tip: combine operators like intitle:AI is:unread."}
            </div>
            <div className="flex flex-col gap-2 px-4 pb-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setSearchOpen(false)}
                className="order-2 sm:order-1 rounded-xl border border-border/60 bg-background/60 px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!searchQuery.trim()}
                className="order-1 sm:order-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm active:scale-[0.98] transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {searchQuery.trim()
                  ? `Show ${filteredArticles.length} result${filteredArticles.length === 1 ? "" : "s"}`
                  : "Enter search term"}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
      />
    </div>
  );
}
