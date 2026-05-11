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
} from "@/hooks/use-rss-data";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { hasUsers } from "./actions/onboarding";
import { useRouter } from "next/navigation";

function toUiArticle(a: any) {
  const publishedAt = new Date(a.publishedAt);
  return {
    ...a,
    feedName: a.feed.name,
    feedIcon: a.feed.icon || "📰",
    publishedAtRaw: publishedAt.getTime(),
    publishedAt: publishedAt.toISOString(),
    readTime: readingTime((a.content || "").replace(/<[^>]*>?/gm, "")).text,
    excerpt: a.excerpt || "",
    author: a.author || "Unknown",
  };
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState<boolean | null>(null);

  const { data: feeds = [], isLoading: feedsLoading } = useFeeds();
  const { data: rawArticles = [], isLoading: articlesLoading } = useArticles(
    selectedFeed,
    selectedCategory,
    searchQuery || undefined,
  );

  const refresh = useRefresh();
  const toggleRead = useToggleRead();
  const toggleStarred = useToggleStarred();
  const toggleReadLater = useToggleReadLater();
  const markAllAsRead = useMarkAllAsRead();
  const fetchFullText = useFetchFullText();
  const { data: labels = [] } = useLabels();
  const { data: savedSearches = [] } = useSavedSearches();
  const createSavedSearch = useCreateSavedSearch();
  const setArticleLabels = useSetArticleLabels();
  const { data: readingPrefs } = useReadingPreferences();

  const unreadBadgeCount = useMemo(() => {
    return feeds.reduce((sum: number, feed: any) => sum + (feed._count?.articles || 0), 0);
  }, [feeds]);

  useEffect(() => {
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (contents?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };

    if (!badgeNavigator.setAppBadge) return;

    const updateBadge =
      unreadBadgeCount > 0
        ? badgeNavigator.setAppBadge(unreadBadgeCount)
        : badgeNavigator.clearAppBadge?.();

    updateBadge?.catch(() => {
      // Badging is optional and platform-dependent.
    });
  }, [unreadBadgeCount]);

  const [readInSession, setReadInSession] = useState<string[]>([]);
  const [autoReadSuppressedArticles, setAutoReadSuppressedArticles] = useState<string[]>([]);
  const [sessionReadArticles, setSessionReadArticles] = useState<any[]>([]);
  const [selectedArticleSnapshot, setSelectedArticleSnapshot] = useState<any | null>(null);

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
      setViewMode((readingPrefs.defaultViewMode as ViewMode) || "list");
      setViewModeInitialized(true);
    }
  }, [readingPrefs, viewModeInitialized]);

  // Reset readInSession when feed or category changes
  useEffect(() => {
    setReadInSession([]);
    setAutoReadSuppressedArticles([]);
    setSessionReadArticles([]);
    setSelectedArticleSnapshot(null);
  }, [selectedFeed, selectedCategory]);

  // Auto-sync feeds on page load (lazy sync)
  useEffect(() => {
    if (status === "authenticated") {
      fetch("/api/sync", { 
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }).then(() => {
        if (typeof window !== "undefined") {
          localStorage.setItem("lastSync", new Date().toISOString());
        }
      }).catch(console.error);
    }
  }, [status]);

  // Transform articles for UI components
  const articles = useMemo(() => {
    return rawArticles.map(toUiArticle);
  }, [rawArticles]);

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


  const filteredArticles = useMemo(() => {
    let list = [...displayArticles];

    // Some views IGNORE the unread filter toggle
    const bypassUnreadFilter = [
      "All",
      "All Articles",
      "Starred",
      "Read Later",
      "Recently Read",
    ].includes(selectedCategory);

    // Apply main view filter - include items that are either:
    // 1. Not yet read, OR
    // 2. Read in this session (clicked but still visible), OR  
    // 3. Already in readInSession (persist visibility after server update)
    if (selectedCategory === "New Articles" || (unreadOnly && !bypassUnreadFilter)) {
      list = list.filter((a) => !a.isRead || readInSession.includes(a.id));
    }

    // Sort AFTER filtering
    const sortOldest = readingPrefs?.defaultArticleSort === "oldest";
    return list.sort((a: any, b: any) =>
      sortOldest ? a.publishedAtRaw - b.publishedAtRaw : b.publishedAtRaw - a.publishedAtRaw,
    );
  }, [displayArticles, unreadOnly, selectedCategory, readInSession, readingPrefs?.defaultArticleSort]);

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
    setSelectedArticleId(null);
    setSelectedArticleSnapshot(null);
  }, []);

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
      return selectedCategory === "New Articles" || unreadOnly || !nextIsRead
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
  }, [displayArticles, selectedArticleSnapshot, selectedCategory, unreadOnly, selectedArticleId, toggleRead]);

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

    // "/" to open search
    if (e.key === "/") {
      e.preventDefault();
      const searchInput = document.querySelector('input[type="search"]') as HTMLInputElement;
      if (searchInput) {
        searchInput.focus();
      }
    } else if (e.key === "Escape") {
      // Close search on Escape
      setSearchQuery("");
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
      markAllAsRead.mutate({
        feedId: selectedFeed,
        category: selectedFeed ? null : selectedCategory,
      });
    } else if (e.key === "S" && e.shiftKey) {
      e.preventDefault();
      handleSaveSearch();
    }
  }, [handleSelectArticle, handleToggleStar, handleToggleReadLater, handleToggleRead, handleRefresh, selectedArticleSnapshot, markAllAsRead, selectedFeed, selectedCategory, handleSaveSearch]);

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
    <div className="fixed inset-0 flex bg-background overflow-hidden selection:bg-accent/20 app-chrome">
      {/* Desktop Sidebar */}
      {!isMobileLayout && (
      <div className="shrink-0">
        <RssSidebar
          feeds={sidebarFeeds}
          selectedFeed={selectedFeed}
          selectedCategory={selectedCategory}
          onSelectFeed={(feedId) => {
            setSelectedFeed(feedId);
            setSelectedArticleId(null);
            setSelectedArticleSnapshot(null);
            if (feedId) setSelectedCategory("All");
          }}
          onSelectCategory={(cat) => {
            setSelectedCategory(cat);
            setSelectedFeed(null);
            setSelectedArticleId(null);
            setSelectedArticleSnapshot(null);
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
            onSelectFeed={(feedId) => {
              setSelectedFeed(feedId);
              setSelectedArticleId(null);
              setSelectedArticleSnapshot(null);
              if (feedId) setSelectedCategory("All");
              setSidebarOpen(false);
            }}
            onSelectCategory={(category) => {
              setSelectedCategory(category);
              setSelectedFeed(null);
              setSelectedArticleId(null);
              setSelectedArticleSnapshot(null);
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
          <div className="relative z-10 flex h-full flex-col border-r border-border/60 bg-card/70 backdrop-blur-2xl">
            <RssHeader
              title={searchQuery ? `Search: "${searchQuery}"` : headerTitle}
              articleCount={filteredArticles.length}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              onToggleSidebar={() => setSidebarOpen(true)}
              onRefresh={handleRefresh}
              isRefreshing={articlesLoading || refresh.isPending}
              unreadOnly={unreadOnly}
              onToggleUnreadOnly={() => setUnreadOnly(!unreadOnly)}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              onMarkAllRead={() =>
                markAllAsRead.mutate({
                  feedId: selectedFeed,
                  category: selectedFeed ? null : selectedCategory,
                })
              }
              isMarkingAllRead={markAllAsRead.isPending}
              onSaveSearch={handleSaveSearch}
              onShowShortcuts={() => setShortcutsOpen(true)}
            />
            <ArticleList
              articles={filteredArticles}
              selectedArticle={selectedArticle}
              onSelectArticle={handleSelectArticle}
              onToggleRead={handleToggleRead}
              onToggleStar={handleToggleStar}
              onToggleReadLater={handleToggleReadLater}
              viewMode={viewMode}
            />
          </div>
        </ResizablePanel>

        <ResizableHandle
          withHandle
          className="bg-border/40 transition-colors hover:bg-accent/35"
        />

        <ResizablePanel defaultSize={64} minSize={45}>
          <div className="flex h-full bg-background">
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
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      )}

      {/* Mobile Article List Panel */}
      {isMobileLayout && !selectedArticle && (
      <div className="relative z-10 flex min-w-0 flex-1 flex-col bg-card/70 backdrop-blur-2xl transition-all duration-300 ease-out">
        <RssHeader
          title={searchQuery ? `Search: "${searchQuery}"` : headerTitle}
          articleCount={filteredArticles.length}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onToggleSidebar={() => setSidebarOpen(true)}
          onRefresh={handleRefresh}
          isRefreshing={articlesLoading || refresh.isPending}
          unreadOnly={unreadOnly}
          onToggleUnreadOnly={() => setUnreadOnly(!unreadOnly)}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onMarkAllRead={() =>
            markAllAsRead.mutate({
              feedId: selectedFeed,
              category: selectedFeed ? null : selectedCategory,
            })
          }
          isMarkingAllRead={markAllAsRead.isPending}
          onSaveSearch={handleSaveSearch}
          onShowShortcuts={() => setShortcutsOpen(true)}
        />
        <ArticleList
          articles={filteredArticles}
          selectedArticle={selectedArticle}
          onSelectArticle={handleSelectArticle}
          onToggleRead={handleToggleRead}
          onToggleStar={handleToggleStar}
          onToggleReadLater={handleToggleReadLater}
          viewMode={viewMode}
        />
        <MobileBottomControls
          unreadOnly={unreadOnly}
          onToggleUnreadOnly={() => setUnreadOnly(!unreadOnly)}
          onToggleSidebar={() => setSidebarOpen(true)}
          onRefresh={handleRefresh}
          isRefreshing={articlesLoading || refresh.isPending}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onMarkAllRead={() =>
            markAllAsRead.mutate({
              feedId: selectedFeed,
              category: selectedFeed ? null : selectedCategory,
            })
          }
          isMarkingAllRead={markAllAsRead.isPending}
          onSaveSearch={handleSaveSearch}
          onShowShortcuts={() => setShortcutsOpen(true)}
        />
      </div>
      )}

      {/* Mobile Article Reader Panel */}
      {isMobileLayout && selectedArticle && (
      <div className="fixed inset-0 z-50 flex bg-background transition-all duration-300 ease-out">
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
        />
      </div>
      )}

      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
      />
    </div>
  );
}
