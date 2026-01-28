"use client";

import { useState, useMemo, useEffect } from "react";
import { useSession } from "next-auth/react";
import { RssSidebar } from "@/components/rss-sidebar";
import { ArticleList } from "@/components/article-list";
import { ArticleReader } from "@/components/article-reader";
import { RssHeader } from "@/components/rss-header";
import {
  useFeeds,
  useArticles,
  useToggleRead,
  useToggleStarred,
  useRefresh,
} from "@/hooks/use-rss-data";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent } from "@/components/ui/sheet";

// Define a type for the raw article data based on its usage
interface RawArticle {
  id: string;
  isRead: boolean;
  isStarred: boolean;
  publishedAt: string;
  excerpt?: string;
  author?: string;
  feed: {
    name: string;
    icon?: string;
  };
  // Add other properties if they exist on the raw article object
  [key: string]: any; // Allow for other properties not explicitly defined
}

import { hasUsers } from "./actions/onboarding";
import { useRouter } from "next/navigation";

export default function RSSReaderPage() {
  const { data: session, status } = useSession();
  const [selectedFeed, setSelectedFeed] = useState<string | null>(null);
  const router = useRouter();

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
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(
    null,
  );
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const { data: feeds = [], isLoading: feedsLoading } = useFeeds();
  const { data: rawArticles = [], isLoading: articlesLoading } =
    useArticles(selectedFeed);

  const refresh = useRefresh();
  const toggleRead = useToggleRead();
  const toggleStarred = useToggleStarred();

  // Transform articles for UI components
  const articles = useMemo(() => {
    return rawArticles.map((a: RawArticle) => ({
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
    // Already filtered by feedId in the query if selectedFeed is set
    return [...articles].sort((a: any, b: any) => {
      if (a.isRead !== b.isRead) return a.isRead ? 1 : -1;
      return (
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
      );
    });
  }, [articles]);

  const currentFeed = selectedFeed
    ? feeds.find((f: any) => f.id === selectedFeed)
    : null;

  const headerTitle = currentFeed ? currentFeed.name : "All Articles";

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
    // Don't trigger if user is typing in an input
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement
    )
      return;

    if (e.key === "j") {
      // Next Article
      const currentIndex = filteredArticles.findIndex(
        (a) => a.id === selectedArticleId,
      );
      const nextArticle = filteredArticles[currentIndex + 1];
      if (nextArticle) handleSelectArticle(nextArticle);
    } else if (e.key === "k") {
      // Previous Article
      const currentIndex = filteredArticles.findIndex(
        (a) => a.id === selectedArticleId,
      );
      const prevArticle = filteredArticles[currentIndex - 1];
      if (prevArticle) handleSelectArticle(prevArticle);
    } else if (e.key === "s" && selectedArticleId) {
      // Toggle Star
      handleToggleStar(selectedArticleId);
    } else if (e.key === "r") {
      // Refresh
      handleRefresh();
    }
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [filteredArticles, selectedArticleId]);

  return (
    <div className="h-dvh flex bg-background overflow-hidden">
      {/* Desktop Sidebar */}
      <div className="hidden lg:block">
        <RssSidebar
          feeds={feeds.map((f: any) => ({
            ...f,
            category: f.category?.name || "Uncategorized",
            unreadCount: f._count?.articles || 0,
            icon: f.icon || "📰",
          }))}
          selectedFeed={selectedFeed}
          selectedCategory={selectedCategory}
          onSelectFeed={(feedId) => {
            setSelectedFeed(feedId);
            setSelectedArticleId(null);
          }}
          onSelectCategory={setSelectedCategory}
        />
      </div>

      {/* Mobile Sidebar Sheet */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="p-0 w-80 border-0">
          <RssSidebar
            feeds={feeds.map((f: any) => ({
              ...f,
              category: f.category?.name || "Uncategorized",
              unreadCount: f._count?.articles || 0,
              icon: f.icon || "📰",
            }))}
            selectedFeed={selectedFeed}
            selectedCategory={selectedCategory}
            onSelectFeed={(feedId) => {
              setSelectedFeed(feedId);
              setSelectedArticleId(null);
              setSidebarOpen(false);
            }}
            onSelectCategory={(category) => {
              setSelectedCategory(category);
              setSidebarOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>

      {/* Article List Panel */}
      <div
        className={cn(
          "w-full lg:w-[420px] flex-shrink-0 flex flex-col border-r border-border bg-card",
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
        />
        <ArticleList
          articles={filteredArticles}
          selectedArticle={selectedArticle}
          onSelectArticle={handleSelectArticle}
        />
      </div>

      {/* Article Reader Panel */}
      <div
        className={cn(
          "flex-1 hidden lg:flex",
          "transition-all duration-300 ease-out",
          selectedArticle && "flex",
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
