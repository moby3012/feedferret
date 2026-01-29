"use client";

import { Article } from "@/lib/rss-data";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Star,
  Share2,
  ExternalLink,
  BookmarkPlus,
  ChevronLeft,
  MoreHorizontal,
  Rss,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ArticleReaderProps {
  article: Article | null;
  onToggleStar: (articleId: string) => void;
  onBack?: () => void;
  showBackButton?: boolean;
}

export function ArticleReader({
  article,
  onToggleStar,
  onBack,
  showBackButton,
}: ArticleReaderProps) {
  if (!article) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background animate-fade-in">
        <div className="text-center max-w-md px-8">
          <div className="w-24 h-24 rounded-3xl bg-muted flex items-center justify-center mx-auto mb-8 shadow-lg overflow-hidden p-6 border border-border/50">
            <img
              src="/logo.svg"
              alt="FeedFerret Logo"
              className="w-12 h-12 invert dark:invert-0"
            />
          </div>
          <h2 className="text-2xl font-bold text-foreground mb-3 text-balance">
            Select an article to read
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed">
            Choose an article from the list to start reading. Your reading
            progress will be saved automatically.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-background animate-fade-in">
      {/* Reader Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-10">
        <div className="flex items-center gap-4">
          {showBackButton && (
            <Button
              variant="ghost"
              size="icon"
              className="w-10 h-10 rounded-xl hover:bg-muted transition-all duration-200 hover:scale-105 active:scale-95"
              onClick={onBack}
            >
              <ChevronLeft className="w-5 h-5" />
            </Button>
          )}
          <div className="flex items-center gap-3">
            <span className="text-2xl">{article.feedIcon}</span>
            <span className="text-base font-semibold text-foreground">
              {article.feedName}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
            onClick={() => onToggleStar(article.id)}
          >
            <Star
              className={cn(
                "w-5 h-5 transition-all duration-300",
                article.isStarred
                  ? "text-amber-500 fill-amber-500 scale-110"
                  : "text-muted-foreground hover:text-amber-400",
              )}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
          >
            <BookmarkPlus className="w-5 h-5 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
          >
            <Share2 className="w-5 h-5 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
          >
            <ExternalLink className="w-5 h-5 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
          >
            <MoreHorizontal className="w-5 h-5 text-muted-foreground" />
          </Button>
        </div>
      </header>

      {/* Article Content */}
      <ScrollArea className="flex-1 overflow-hidden min-h-0">
        <article className="max-w-3xl mx-auto px-6 py-12">
          {/* Article Header */}
          <header className="mb-10 animate-fade-in-up">
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground leading-tight mb-6 text-balance tracking-tight">
              {article.title}
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-base text-muted-foreground">
              <span className="font-semibold text-foreground text-lg">
                {article.author}
              </span>
              <span className="text-muted-foreground/40">·</span>
              <span>{article.publishedAt}</span>
              <span className="text-muted-foreground/40">·</span>
              <span>{article.readTime}</span>
            </div>
          </header>

          {/* Hero Image */}
          {article.imageUrl && (
            <figure className="mb-12 -mx-6 sm:mx-0 animate-scale-in">
              <div className="aspect-[16/9] sm:rounded-2xl overflow-hidden bg-muted shadow-2xl shadow-black/10">
                <img
                  src={article.imageUrl || "/placeholder.svg"}
                  alt=""
                  className="w-full h-full object-cover transition-transform duration-700 hover:scale-105"
                />
              </div>
            </figure>
          )}

          {/* Article Body */}
          <div className="animate-fade-in-up animation-delay-200">
            {article.content.split("\n\n").map((paragraph, index) => (
              <p
                key={index}
                className="text-foreground/90 leading-[1.8] mb-7 text-lg sm:text-xl"
              >
                {paragraph}
              </p>
            ))}
          </div>

          {/* Article Footer */}
          <footer className="mt-16 pt-8 border-t border-border animate-fade-in-up animation-delay-300">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center text-2xl shadow-lg">
                  {article.feedIcon}
                </div>
                <div>
                  <p className="text-lg font-semibold text-foreground">
                    {article.feedName}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    View all articles
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="lg"
                className="rounded-xl px-6 font-semibold transition-all duration-200 hover:scale-105 active:scale-95 bg-transparent"
              >
                Subscribe
              </Button>
            </div>
          </footer>
        </article>
      </ScrollArea>
    </div>
  );
}
