"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import readingTime from "reading-time";
import { RssSidebar } from "@/components/rss-sidebar";
import { ArticleList } from "@/components/article-list";
import { ArticleReader } from "@/components/article-reader";
import { RssHeader, ViewMode } from "@/components/rss-header";
import {
  useFeeds,
  useArticles,
  useToggleRead,
  useToggleStarred,
  useRefresh,
  useMarkAllAsRead,
  useFetchFullText,
  useLabels,
  useSavedSearches,
  useCreateSavedSearch,
  useSetArticleLabels,
} from "@/hooks/use-rss-data";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent } from "@/components/ui/sheet";
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const { data: feeds = [], isLoading: feedsLoading } = useFeeds();
  const { data: rawArticles = [], isLoading: articlesLoading } = useArticles(
    selectedFeed,
    selectedCategory,
    searchQuery || undefined,
  );

  const refresh = useRefresh();
  const toggleRead = useToggleRead();
  const toggleStarred = useToggleStarred();
  const markAllAsRead = useMarkAllAsRead();
  const fetchFullText = useFetchFullText();
  const { data: labels = [] } = useLabels();
  const { data: savedSearches = [] } = useSavedSearches();
  const createSavedSearch = useCreateSavedSearch();
  const setArticleLabels = useSetArticleLabels();
  const [readInSession, setReadInSession] = useState<string[]>([]);
  const [sessionReadArticles, setSessionReadArticles] = useState<any[]>([]);
  const [selectedArticleSnapshot, setSelectedArticleSnapshot] = useState<any | null>(null);

  // Reset readInSession when feed or category changes
  useEffect(() => {
    setReadInSession([]);
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
    () => displayArticles.find((a: any) => a.id === selectedArticleId) || selectedArticleSnapshot,
    [displayArticles, selectedArticleId, selectedArticleSnapshot],
  );

  const filteredArticles = useMemo(() => {
    let list = [...displayArticles];

    // Some views IGNORE the unread filter toggle
    const bypassUnreadFilter = [
      "All",
      "All Articles",
      "Starred",
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
    return list.sort((a: any, b: any) => b.publishedAtRaw - a.publishedAtRaw);
  }, [displayArticles, unreadOnly, selectedCategory, readInSession]);

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
    if (!article || article.isRead || readInSession.includes(article.id)) return;
      const readArticle = { ...article, isRead: true, readAt: new Date() };
      setReadInSession((prev) => [...prev, article.id]);
      setSessionReadArticles((prev) => [
        readArticle,
        ...prev.filter((a) => a.id !== article.id),
      ]);
      setSelectedArticleSnapshot(readArticle);
      toggleRead.mutate({ articleId: article.id, isRead: true });
  }, [readInSession, toggleRead]);

  const handleSelectArticle = useCallback((article: any) => {
    setSelectedArticleId(article.id);
    setSelectedArticleSnapshot(article);
  }, []);

  useEffect(() => {
    if (!selectedArticle || selectedArticle.isRead || readInSession.includes(selectedArticle.id)) {
      return;
    }

    const timer = window.setTimeout(() => {
      markArticleRead(selectedArticle);
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [selectedArticle, readInSession, markArticleRead]);

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
      e.target instanceof HTMLTextAreaElement
    )
      return;

    const currentFilteredArticles = filteredArticlesRef.current;
    const currentSelectedArticleId = selectedArticleIdRef.current;

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
    } else if (e.key === "s" && currentSelectedArticleId) {
      handleToggleStar(currentSelectedArticleId);
    } else if (e.key === "m" && currentSelectedArticleId) {
      handleToggleRead(currentSelectedArticleId);
    } else if (e.key === "o" && selectedArticleSnapshot?.link) {
      window.open(selectedArticleSnapshot.link, "_blank", "noopener,noreferrer");
    } else if (e.key === "r") {
      handleRefresh();
    }
  }, [handleSelectArticle, handleToggleStar, handleToggleRead, handleRefresh, selectedArticleSnapshot]);

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

  return (
    <div className="fixed inset-0 flex bg-background overflow-hidden selection:bg-accent/20 app-chrome">
      {/* Desktop Sidebar */}
      <div className="hidden lg:block shrink-0">
        <RssSidebar
          feeds={sidebarFeeds}
          selectedFeed={selectedFeed}
          selectedCategory={selectedCategory}
          onSelectFeed={(feedId) => {
            setSelectedFeed(feedId);
            setSelectedArticleId(null);
            if (feedId) setSelectedCategory("All");
          }}
          onSelectCategory={(cat) => {
            setSelectedCategory(cat);
            setSelectedFeed(null);
            setSelectedArticleId(null);
          }}
        />
      </div>

      {/* Mobile Sidebar Sheet */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="p-0 w-80 border-0">
          <RssSidebar
            feeds={sidebarFeeds}
            selectedFeed={selectedFeed}
            selectedCategory={selectedCategory}
            onSelectFeed={(feedId) => {
              setSelectedFeed(feedId);
              setSelectedArticleId(null);
              if (feedId) setSelectedCategory("All");
              setSidebarOpen(false);
            }}
            onSelectCategory={(category) => {
              setSelectedCategory(category);
              setSelectedFeed(null);
              setSelectedArticleId(null);
              setSidebarOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>

      {/* Desktop: resizable article list + reader */}
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
            />
            <ArticleList
              articles={filteredArticles}
              selectedArticle={selectedArticle}
              onSelectArticle={handleSelectArticle}
              onToggleRead={handleToggleRead}
              onToggleStar={handleToggleStar}
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
              onToggleRead={handleToggleRead}
              onFetchFullText={handleFetchFullText}
              isFetchingFullText={fetchFullText.isPending}
              labels={labels}
              onSetLabels={handleSetLabels}
              onBack={() => setSelectedArticleId(null)}
              showBackButton={!!selectedArticle}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Mobile Article List Panel */}
      <div
        className={cn(
          "relative z-10 flex flex-1 flex-col border-r border-border/60 bg-card/70 backdrop-blur-2xl transition-all duration-300 ease-out lg:hidden",
          selectedArticle && "hidden",
        )}
      >
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
        />
        <ArticleList
          articles={filteredArticles}
          selectedArticle={selectedArticle}
          onSelectArticle={handleSelectArticle}
          onToggleRead={handleToggleRead}
          onToggleStar={handleToggleStar}
          viewMode={viewMode}
        />
      </div>

      {/* Mobile Article Reader Panel */}
      <div
        className={cn(
          "hidden flex-1 bg-background transition-all duration-300 ease-out lg:hidden",
          selectedArticle && "fixed inset-0 z-50 flex",
        )}
      >
        <ArticleReader
          article={selectedArticle}
          onToggleStar={handleToggleStar}
          onToggleRead={handleToggleRead}
          onFetchFullText={handleFetchFullText}
          isFetchingFullText={fetchFullText.isPending}
          labels={labels}
          onSetLabels={handleSetLabels}
          onBack={() => setSelectedArticleId(null)}
          showBackButton={!!selectedArticle}
        />
      </div>
    </div>
  );
}
