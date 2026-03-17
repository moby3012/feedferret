"use client";

import { useState, useMemo, useEffect } from "react";
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
} from "@/hooks/use-rss-data";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { hasUsers } from "./actions/onboarding";
import { useRouter } from "next/navigation";

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
  const [readInSession, setReadInSession] = useState<string[]>([]);

  // Reset readInSession when feed or category changes
  useEffect(() => {
    setReadInSession([]);
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
    return rawArticles.map((a: any) => ({
      ...a,
      feedName: a.feed.name,
      feedIcon: a.feed.icon || "📰",
      publishedAtRaw: new Date(a.publishedAt).getTime(),
      readTime: readingTime((a.content || "").replace(/<[^>]*>?/gm, "")).text,
      excerpt: a.excerpt || "",
      author: a.author || "Unknown",
    }));
  }, [rawArticles]);

  const selectedArticle = useMemo(
    () => articles.find((a: any) => a.id === selectedArticleId) || null,
    [articles, selectedArticleId],
  );

  const filteredArticles = useMemo(() => {
    let list = [...articles];

    // Some views IGNORE the unread filter toggle
    const bypassUnreadFilter = [
      "All",
      "All Articles",
      "Starred",
      "Recently Read",
    ].includes(selectedCategory);

    // Apply main view filter
    if (selectedCategory === "New Articles") {
      list = list.filter((a) => !a.isRead || readInSession.includes(a.id));
    } else if (unreadOnly && !bypassUnreadFilter) {
      list = list.filter((a) => !a.isRead || readInSession.includes(a.id));
    }

    // Sort AFTER filtering
    return list.sort((a: any, b: any) => b.publishedAtRaw - a.publishedAtRaw);
  }, [articles, unreadOnly, selectedCategory, readInSession]);

  const headerTitle = useMemo(() => {
    if (selectedFeed) {
      return feeds.find((f: any) => f.id === selectedFeed)?.name || "Feed";
    }
    return selectedCategory;
  }, [selectedFeed, selectedCategory, feeds]);

  const handleSelectArticle = (article: any) => {
    setSelectedArticleId(article.id);
    if (!article.isRead && !readInSession.includes(article.id)) {
      setReadInSession((prev) => [...prev, article.id]);
      toggleRead.mutate({ articleId: article.id, isRead: true });
    }
  };

  const handleToggleStar = (articleId: string) => {
    const article = articles.find((a: any) => a.id === articleId);
    if (article) {
      toggleStarred.mutate({ articleId, isStarred: !article.isStarred });
    }
  };

  const handleRefresh = async () => {
    refresh.mutate();
  };

  // Keyboard Shortcuts
  const handleKeyDown = (e: KeyboardEvent) => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement
    )
      return;

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
      const currentIndex = filteredArticles.findIndex(
        (a) => a.id === selectedArticleId,
      );
      const nextArticle = filteredArticles[currentIndex + 1];
      if (nextArticle) handleSelectArticle(nextArticle);
    } else if (e.key === "k") {
      const currentIndex = filteredArticles.findIndex(
        (a) => a.id === selectedArticleId,
      );
      const prevArticle = filteredArticles[currentIndex - 1];
      if (prevArticle) handleSelectArticle(prevArticle);
    } else if (e.key === "s" && selectedArticleId) {
      handleToggleStar(selectedArticleId);
    } else if (e.key === "r") {
      handleRefresh();
    }
  };

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
  }, [filteredArticles, selectedArticleId]);

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
    <div className="fixed inset-0 flex bg-background overflow-hidden selection:bg-accent/20">
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

      {/* Article List Panel */}
      <div
        className={cn(
          "flex-1 lg:w-[420px] lg:flex-none flex flex-col border-r border-border bg-card relative z-10",
          "transition-all duration-300 ease-out",
          selectedArticle && "hidden lg:flex",
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
          onMarkAllRead={() => markAllAsRead.mutate(selectedFeed || undefined)}
          isMarkingAllRead={markAllAsRead.isPending}
        />
        <ArticleList
          articles={filteredArticles}
          selectedArticle={selectedArticle}
          onSelectArticle={handleSelectArticle}
          viewMode={viewMode}
        />
      </div>

      {/* Article Reader Panel */}
      <div
        className={cn(
          "flex-1 hidden lg:flex bg-background",
          "transition-all duration-300 ease-out",
          selectedArticle &&
            "flex fixed inset-0 z-50 lg:relative lg:inset-auto",
        )}
      >
        <ArticleReader
          article={selectedArticle}
          onToggleStar={handleToggleStar}
          onBack={() => setSelectedArticleId(null)}
          showBackButton={!!selectedArticle}
        />
      </div>
    </div>
  );
}
