"use client";

import { useTranslations } from "next-intl";
import { Search as SearchIcon, X as XIcon, BookmarkPlus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArticleList } from "@/components/article-list";
import { cn } from "@/lib/utils";

interface SearchResultsViewProps {
  searchQuery: string;
  articles: any[];
  selectedArticle: any | null;
  isLoading?: boolean;
  unreadCount?: number;
  onCloseSearch: () => void;
  onEditSearch: () => void;
  onSaveSearch?: () => void;
  onSelectArticle: (article: any) => void;
  onToggleRead?: (articleId: string) => void;
  onToggleStar?: (articleId: string) => void;
  onToggleReadLater?: (articleId: string) => void;
  onMarkRead?: (articleId: string) => void;
  markReadOnScroll?: boolean;
  filterKey?: string;
  transitionStyle?: "fade" | "flip" | "filter";
  isMobile?: boolean;
}

export function SearchResultsView({
  searchQuery,
  articles,
  selectedArticle,
  isLoading,
  unreadCount,
  onCloseSearch,
  onEditSearch,
  onSaveSearch,
  onSelectArticle,
  onToggleRead,
  onToggleStar,
  onToggleReadLater,
  onMarkRead,
  markReadOnScroll,
  filterKey,
  transitionStyle,
  isMobile,
}: SearchResultsViewProps) {
  const t = useTranslations("searchResults");
  const tA11y = useTranslations("accessibility");

  const count = articles.length;

  return (
    <div className="relative z-10 flex min-w-0 flex-1 flex-col min-h-0">
      <header className="relative border-b border-border/60 bg-card/85 backdrop-blur-2xl animate-fade-in">
        <div className="flex items-start gap-3 px-4 pt-4 pb-3 sm:px-5">
          <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
            <SearchIcon className="h-5 w-5" />
          </div>

          <button
            type="button"
            onClick={onEditSearch}
            className="group min-w-0 flex-1 text-left"
            aria-label={t("editQuery")}
            title={t("editQuery")}
          >
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold tracking-[-0.02em] text-foreground sm:text-xl">
                &ldquo;{searchQuery}&rdquo;
              </h2>
              <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <p className="mt-0.5 truncate text-xs font-medium text-muted-foreground">
              {t("resultsCount", { count })}
              {typeof unreadCount === "number" && count > 0 && (
                <span className="ms-2 text-muted-foreground/70">
                  · {t("unreadCount", { count: unreadCount })}
                </span>
              )}
            </p>
          </button>

          <div className="flex shrink-0 items-center gap-1">
            {onSaveSearch && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onSaveSearch}
                className="hidden h-10 w-10 rounded-xl text-muted-foreground hover:text-foreground sm:inline-flex"
                aria-label={t("saveSearch")}
                title={t("saveSearch")}
              >
                <BookmarkPlus className="h-4 w-4" />
              </Button>
            )}
            <button
              type="button"
              onClick={onCloseSearch}
              className={cn(
                "flex shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-background/80 text-foreground shadow-sm transition-all hover:bg-muted active:scale-95",
                "h-11 w-11 sm:h-10 sm:w-10",
              )}
              aria-label={t("closeSearch")}
              title={t("closeSearch")}
            >
              <XIcon className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      {count === 0 && !isLoading ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center animate-fade-in">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground">
            <SearchIcon className="h-7 w-7" />
          </div>
          <h3 className="text-base font-semibold text-foreground">{t("emptyTitle")}</h3>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {t("emptyDescription")}
          </p>
          <Button
            type="button"
            onClick={onEditSearch}
            variant="outline"
            className="mt-5 rounded-xl"
          >
            <Pencil className="me-2 h-4 w-4" />
            {t("editQuery")}
          </Button>
        </div>
      ) : (
        <div className={cn("flex flex-1 min-h-0 flex-col", isMobile && "pb-24")}>
          <ArticleList
            articles={articles}
            selectedArticle={selectedArticle}
            onSelectArticle={onSelectArticle}
            onToggleRead={onToggleRead}
            onToggleStar={onToggleStar}
            onToggleReadLater={onToggleReadLater}
            viewMode="list"
            isLoading={isLoading}
            markReadOnScroll={markReadOnScroll}
            filterKey={filterKey}
            transitionStyle={transitionStyle}
            onMarkRead={onMarkRead}
            searchQuery={searchQuery}
          />
        </div>
      )}
    </div>
  );
}
