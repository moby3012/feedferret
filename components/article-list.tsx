"use client";

import { cn } from "@/lib/utils";
import { Article } from "@/lib/rss-data";
import { Star, Circle, Clock, User, ImageIcon } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ArticleListProps {
  articles: Article[];
  selectedArticle: Article | null;
  onSelectArticle: (article: Article) => void;
  viewMode?: "list" | "grid" | "magazine" | "minimal";
}

export function ArticleList({
  articles,
  selectedArticle,
  onSelectArticle,
  viewMode = "list",
}: ArticleListProps) {
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
          "p-3 space-y-3",
          viewMode === "magazine" &&
            "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-4 space-y-0",
        )}
      >
        {articles.map((article, index) => (
          <ArticlePreview
            key={article.id}
            article={article}
            isSelected={selectedArticle?.id === article.id}
            onClick={() => onSelectArticle(article)}
            index={index}
            viewMode={viewMode}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function ArticlePreview({
  article,
  isSelected,
  onClick,
  index,
  viewMode,
}: {
  article: Article;
  isSelected: boolean;
  onClick: () => void;
  index: number;
  viewMode: string;
}) {
  if (viewMode === "minimal") {
    return (
      <article
        onClick={onClick}
        className={cn(
          "px-4 py-2.5 cursor-pointer rounded-xl transition-all duration-200 flex items-center gap-3",
          isSelected
            ? "bg-accent/10 ring-1 ring-accent/20"
            : "hover:bg-muted/50",
          !article.isRead && "font-semibold border-l-4 border-primary pl-3",
        )}
      >
        <span className="text-base shrink-0">{article.feedIcon}</span>
        <h3 className="flex-1 text-sm truncate">{article.title}</h3>
        <span className="text-[10px] text-muted-foreground whitespace-nowrap">
          {article.publishedAt}
        </span>
      </article>
    );
  }

  if (viewMode === "magazine") {
    return (
      <article
        onClick={onClick}
        className={cn(
          "cursor-pointer rounded-2xl overflow-hidden transition-all duration-300 border border-transparent bg-card shadow-sm hover:shadow-xl hover:-translate-y-1",
          isSelected && "ring-2 ring-primary border-primary",
          !article.isRead && "ring-1 ring-primary/20",
        )}
      >
        <div className="aspect-[16/10] bg-muted relative overflow-hidden">
          {article.imageUrl ? (
            <img
              src={article.imageUrl}
              alt=""
              className="w-full h-full object-cover transition-transform duration-700 hover:scale-110"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground/30">
              <ImageIcon className="w-12 h-12" />
            </div>
          )}
          <div className="absolute top-3 left-3 px-2 py-1 bg-black/50 backdrop-blur-md rounded-lg text-white text-[10px] font-bold">
            {article.feedName}
          </div>
        </div>
        <div className="p-4 space-y-3">
          <h3 className="text-lg font-bold leading-tight line-clamp-2">
            {article.title}
          </h3>
          <p className="text-sm text-muted-foreground line-clamp-3 leading-relaxed">
            {article.excerpt}
          </p>
          <div className="flex items-center justify-between pt-2 border-t border-border/50">
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-medium">
              <Clock className="w-3 h-3" />
              {article.publishedAt}
            </div>
            {article.isStarred && (
              <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
            )}
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
        "p-4 cursor-pointer rounded-2xl transition-all duration-300 ease-out group animate-fade-in-up",
        "hover:scale-[1.01] active:scale-[0.99]",
        isSelected
          ? "bg-accent/10 ring-1 ring-accent/20 shadow-lg shadow-accent/5"
          : "hover:bg-muted/60 hover:shadow-md",
        !article.isRead && "bg-card shadow-sm",
      )}
    >
      <div className="flex gap-4">
        {article.imageUrl && (
          <div className="w-28 h-28 sm:w-32 sm:h-32 rounded-xl overflow-hidden flex-shrink-0 bg-muted relative group-hover:shadow-lg transition-shadow duration-300">
            <img
              src={article.imageUrl || "/placeholder.svg"}
              alt=""
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
            {!article.isRead && (
              <div className="absolute top-2 left-2 w-2.5 h-2.5 rounded-full bg-accent animate-pulse-gentle" />
            )}
          </div>
        )}

        <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">{article.feedIcon}</span>
            <span className="text-sm font-medium text-muted-foreground truncate">
              {article.feedName}
            </span>
            <span className="text-muted-foreground/50">·</span>
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {article.publishedAt}
            </span>
            {article.isStarred && (
              <Star className="w-4 h-4 text-amber-500 fill-amber-500 ml-auto transition-transform duration-300 group-hover:scale-110" />
            )}
          </div>

          <h3
            className={cn(
              "text-lg leading-snug mb-2 line-clamp-2 text-balance transition-colors duration-200",
              !article.isRead
                ? "font-semibold text-foreground"
                : "font-medium text-foreground/75",
            )}
          >
            {article.title}
          </h3>

          <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed mb-3">
            {article.excerpt}
          </p>

          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="font-medium truncate max-w-[100px]">
              {article.author}
            </span>
            <span className="text-muted-foreground/50">·</span>
            <span>{article.readTime}</span>
          </div>
        </div>
      </div>
    </article>
  );
}
