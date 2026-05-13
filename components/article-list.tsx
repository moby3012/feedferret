"use client";

import Image from "next/image";
import { cn } from "@/lib/utils";
import { Article } from "@/lib/rss-data";
import { Star, Circle, Clock, CheckCircle2, CircleDot, Bookmark, Layers } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useState, useRef, useEffect } from "react";

interface ArticleListProps {
  articles: Article[];
  selectedArticle: Article | null;
  onSelectArticle: (article: Article) => void;
  onToggleRead?: (articleId: string) => void;
  onToggleStar?: (articleId: string) => void;
  onToggleReadLater?: (articleId: string) => void;
  viewMode?: "list" | "grid" | "magazine" | "minimal";
  pageSize?: number;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear()).slice(2);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}.${month}.${year} - ${hours}:${minutes}`;
}

export function ArticleList({
  articles,
  selectedArticle,
  onSelectArticle,
  onToggleRead,
  onToggleStar,
  onToggleReadLater,
  viewMode = "list",
  pageSize,
}: ArticleListProps) {
  const [visibleCount, setVisibleCount] = useState(pageSize ?? 30);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVisibleCount(pageSize ?? 30);
  }, [articles, pageSize]);

  const visibleArticles = articles.slice(0, visibleCount);
  const hasMore = visibleCount < articles.length;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount(prev => Math.min(prev + (pageSize ?? 30), articles.length));
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, articles.length, pageSize]);

  if (articles.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 animate-fade-in">
        <div className="text-center">
          <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mx-auto mb-5">
            <Circle className="w-10 h-10 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-semibold text-foreground mb-2">
            No articles
          </h3>
          <p className="text-base text-muted-foreground">
            Add feeds to start reading
          </p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 overflow-hidden min-h-0">
      <div
        className={cn(
          "p-3 pb-28 lg:pb-3 space-y-2.5",
          viewMode === "magazine" &&
            "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-4 space-y-0",
        )}
      >
        {visibleArticles.map((article, index) => (
          <ArticlePreview
            key={article.id}
            article={article}
            isSelected={selectedArticle?.id === article.id}
            onClick={() => onSelectArticle(article)}
            onToggleRead={onToggleRead}
            onToggleStar={onToggleStar}
            onToggleReadLater={onToggleReadLater}
            index={index}
            viewMode={viewMode}
          />
        ))}
        {hasMore && (
          <div ref={sentinelRef} className="flex items-center justify-center py-6 text-sm text-muted-foreground">
            <div className="w-5 h-5 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin mr-2" />
            Loading more...
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function ArticlePreview({
  article,
  isSelected,
  onClick,
  onToggleRead,
  onToggleStar,
  onToggleReadLater,
  index,
  viewMode,
}: {
  article: Article;
  isSelected: boolean;
  onClick: () => void;
  onToggleRead?: (articleId: string) => void;
  onToggleStar?: (articleId: string) => void;
  onToggleReadLater?: (articleId: string) => void;
  index: number;
  viewMode: string;
}) {
  if (viewMode === "minimal") {
    return (
      <article
        onClick={onClick}
        className={cn(
          "px-4 py-3 cursor-pointer rounded-2xl transition-all duration-200 flex min-w-0 max-w-full items-center gap-3 overflow-hidden",
          isSelected
            ? "bg-accent/10 ring-1 ring-accent/20"
            : "hover:bg-muted/50",
          !article.isRead && "font-semibold border-l-4 border-brand pl-3",
        )}
      >
        <span className="text-base shrink-0">{article.feedIcon}</span>
        {!article.isRead && <CircleDot className="w-3.5 h-3.5 text-brand shrink-0" />}
        <h3 className="flex-1 text-sm truncate">{article.title}</h3>
        {article.isStarred && (
          <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500 shrink-0" />
        )}
        {article.isReadLater && (
          <Bookmark className="w-3.5 h-3.5 text-accent fill-accent shrink-0" />
        )}
        <span className="text-[10px] text-muted-foreground whitespace-nowrap">
          {formatDate(article.publishedAt)}
        </span>
      </article>
    );
  }

  if (viewMode === "magazine") {
    return (
      <article
        onClick={onClick}
        className={cn(
          "cursor-pointer rounded-3xl overflow-hidden transition-all duration-300 border border-border/55 bg-card/75 shadow-sm hover:shadow-lg hover:-translate-y-0.5 backdrop-blur-xl min-w-0 max-w-full",
          isSelected && "ring-2 ring-brand border-brand",
          !article.isRead && "ring-1 ring-brand/20",
        )}
      >
        {article.imageUrl && (
          <div className="aspect-[16/10] bg-muted relative overflow-hidden">
            <Image
              src={article.imageUrl}
              alt=""
              fill
              sizes="(max-width: 640px) 100vw, 400px"
              className="object-cover transition-transform duration-700 hover:scale-110"
            />
            <div className="absolute top-3 left-3 px-2 py-1 bg-black/50 backdrop-blur-md rounded-lg text-white text-[10px] font-bold">
              {article.feedName}
            </div>
          </div>
        )}
        {!article.imageUrl && (
          <div className="px-4 pt-3">
            <span className="inline-block px-2 py-1 bg-black/10 dark:bg-white/10 rounded-lg text-[10px] font-bold">{article.feedName}</span>
          </div>
        )}
        <div className="p-4 space-y-3">
        <h3 className={cn("text-lg leading-tight line-clamp-2 break-words [overflow-wrap:anywhere]", article.isRead ? "font-semibold text-foreground/75" : "font-bold")}>
            {article.title}
          </h3>
          <p className="text-sm text-muted-foreground line-clamp-3 leading-relaxed break-words [overflow-wrap:anywhere]">
            {article.excerpt}
          </p>
          <div className="flex items-center justify-between pt-2 border-t border-border/50">
            <div className="flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground font-medium">
              <Clock className="w-3 h-3" />
              {formatDate(article.publishedAt)}
            </div>
            <div className="flex items-center gap-1">
              {article.isStarred && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleStar?.(article.id); }}
                  className="rounded-md p-1 hover:bg-amber-500/10"
                  aria-label="Toggle star"
                >
                  <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                </button>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggleReadLater?.(article.id); }}
                className={cn("rounded-md p-1 transition-colors", article.isReadLater ? "text-accent" : "text-muted-foreground/50 hover:text-accent hover:bg-accent/10")}
                aria-label={article.isReadLater ? "Remove from Read Later" : "Save to Read Later"}
                title={article.isReadLater ? "Remove from Read Later" : "Save to Read Later"}
              >
                <Bookmark className={cn("w-3.5 h-3.5", article.isReadLater && "fill-accent")} />
              </button>
            </div>
          </div>
        </div>
      </article>
    );
  }

  // Classic View (Default)
  return (
    <article
      onClick={onClick}
      style={{ animationDelay: `${Math.min(index * 50, 300)}ms` }}
      className={cn(
        "p-3 sm:p-3.5 cursor-pointer rounded-2xl sm:rounded-3xl transition-all duration-300 ease-out group animate-fade-in-up border min-w-0 max-w-full overflow-hidden",
        "active:scale-[0.995]",
        isSelected
          ? "bg-accent/10 border-accent/25 shadow-lg shadow-accent/5"
          : "border-transparent hover:border-border/70 hover:bg-card/80 hover:shadow-sm",
        !article.isRead ? "bg-card/90 shadow-sm" : "opacity-80",
      )}
    >
      <div className="flex min-w-0 gap-3 sm:gap-4">
        {article.imageUrl && (
          <div className="w-24 h-24 sm:w-32 sm:h-32 rounded-xl overflow-hidden flex-shrink-0 bg-muted relative group-hover:shadow-lg transition-shadow duration-300">
            <Image
              src={article.imageUrl || "/placeholder.svg"}
              alt=""
              fill
              sizes="(max-width: 640px) 96px, 128px"
              className="object-cover transition-transform duration-500 group-hover:scale-105"
            />
            {!article.isRead && (
              <div className="absolute top-2 left-2 w-2.5 h-2.5 rounded-full bg-brand animate-pulse-gentle" />
            )}
          </div>
        )}

        <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
          <div className="flex items-center gap-1.5 sm:gap-2 mb-2">
            <span className="text-lg">{article.feedIcon}</span>
            <span className="text-sm font-medium text-muted-foreground truncate">
              {article.feedName}
            </span>
            {(article.duplicateCount ?? 0) > 0 && (
              <span
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px] font-medium shrink-0"
                title={`Also in ${article.duplicateCount} other feed${(article.duplicateCount ?? 0) > 1 ? "s" : ""}`}
              >
                <Layers className="w-2.5 h-2.5" />
                {article.duplicateCount}
              </span>
            )}
            {article.isDuplicate && article.canonicalFeedName && (
              <span
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground/70 text-[10px] font-medium shrink-0"
                title={`First seen in: ${article.canonicalFeedName}`}
              >
                <Layers className="w-2.5 h-2.5" />
                dup
              </span>
            )}
            <span className="text-muted-foreground/50">·</span>
            <span className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">
              {formatDate(article.publishedAt)}
            </span>
            <div className="ml-auto flex items-center gap-1">
              {article.isStarred && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleStar?.(article.id); }}
                  className="rounded-lg p-1 hover:bg-amber-500/10 transition-colors"
                  aria-label="Remove star"
                >
                  <Star className="w-4 h-4 text-amber-500 fill-amber-500 transition-transform duration-300 group-hover:scale-110" />
                </button>
              )}
              {article.isReadLater && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleReadLater?.(article.id); }}
                  className="rounded-lg p-1 hover:bg-accent/10 transition-colors"
                  aria-label="Remove from Read Later"
                >
                  <Bookmark className="w-4 h-4 text-accent fill-accent" />
                </button>
              )}
            </div>
          </div>

          <h3
            className={cn(
              "text-[0.98rem] sm:text-[1rem] leading-snug mb-2 line-clamp-2 text-balance transition-colors duration-200 tracking-[-0.015em] break-words [overflow-wrap:anywhere]",
              !article.isRead
                ? "font-semibold text-foreground"
                : "font-medium text-foreground/75",
            )}
          >
            {article.title}
          </h3>

          <p className="text-sm text-muted-foreground line-clamp-1 sm:line-clamp-2 leading-relaxed mb-3 break-words [overflow-wrap:anywhere]">
            {article.excerpt}
          </p>

          {!!article.labels?.length && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {article.labels.slice(0, 3).map((item) => (
                <span
                  key={item.label.id}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: item.label.color }}
                  />
                  {item.label.name}
                </span>
              ))}
            </div>
          )}

          <div className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
            <span className="font-medium truncate max-w-[100px]">
              {article.author}
            </span>
            <div className="ml-auto flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggleRead?.(article.id); }}
                className="rounded-lg p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground"
                aria-label={article.isRead ? "Mark as unread" : "Mark as read"}
                title={article.isRead ? "Mark as unread" : "Mark as read"}
              >
                {article.isRead ? <Circle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
              </button>
              {!article.isStarred && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleStar?.(article.id); }}
                  className="rounded-lg p-1.5 hover:bg-amber-500/10 text-muted-foreground hover:text-amber-500"
                  aria-label="Add star"
                  title="Star"
                >
                  <Star className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggleReadLater?.(article.id); }}
                className={cn("rounded-lg p-1.5 transition-colors", article.isReadLater ? "text-accent bg-accent/10" : "text-muted-foreground hover:text-accent hover:bg-accent/10")}
                aria-label={article.isReadLater ? "Remove from Read Later" : "Save to Read Later"}
                title={article.isReadLater ? "Remove from Read Later (l)" : "Save to Read Later (l)"}
              >
                <Bookmark className={cn("w-4 h-4", article.isReadLater && "fill-accent")} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
