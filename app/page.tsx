"use client";

import { useState, useMemo, useEffect } from "react";
import { useSession } from "next-auth/react";
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

  const { data: feeds = [], isLoading: feedsLoading } = useFeeds();
  const { data: rawArticles = [], isLoading: articlesLoading } = useArticles(
    selectedFeed,
    selectedCategory,
  );

  const refresh = useRefresh();
  const toggleRead = useToggleRead();
  const toggleStarred = useToggleStarred();

  // Transform articles for UI components
  const articles = useMemo(() => {
    return rawArticles.map((a: any) => ({
      ...a,
      feedName: a.feed.name,
      feedIcon: a.feed.icon || "📰",
      publishedAt: new Date(a.publishedAt).toLocaleDateString(),
      readTime: "5 min read", // Placeholder
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
    if (unreadOnly) {
      list = list.filter((a) => !a.isRead);
    }
    return list.sort((a: any, b: any) => {
      return (
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
      );
    });
  }, [articles, unreadOnly]);

  const headerTitle = useMemo(() => {
    if (selectedFeed) {
      return feeds.find((f: any) => f.id === selectedFeed)?.name || "Feed";
    }
    return selectedCategory;
  }, [selectedFeed, selectedCategory, feeds]);

  const handleSelectArticle = (article: any) => {
    setSelectedArticleId(article.id);
    if (!article.isRead) {
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

    if (e.key === "j") {
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
          title={headerTitle}
          articleCount={filteredArticles.length}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onToggleSidebar={() => setSidebarOpen(true)}
          onRefresh={handleRefresh}
          isRefreshing={articlesLoading || refresh.isPending}
          unreadOnly={unreadOnly}
          onToggleUnreadOnly={() => setUnreadOnly(!unreadOnly)}
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
