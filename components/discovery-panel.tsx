"use client";

import { useTranslations } from "next-intl";
import { useState, useEffect, useCallback } from "react";
import { Search, ArrowLeft, Plus, Loader2, Rss, Globe, AlertCircle, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  useDiscoverySearch,
  useDiscoveryCategories,
  useDiscoveryCatalog,
  type DiscoveryFeed,
  type CatalogFeed,
} from "@/hooks/use-discovery";
import { useDebounce } from "@/hooks/use-debounce";

interface DiscoveryPanelProps {
  onAddFeed: (url: string, title?: string) => void;
  isAddingFeed: boolean;
  addingUrl: string | null;
  subscribedUrls?: Set<string>;
}

export function DiscoveryPanel({
  onAddFeed,
  isAddingFeed,
  addingUrl,
  subscribedUrls = new Set(),
}: DiscoveryPanelProps) {
  const t = useTranslations("discovery");
  const [mode, setMode] = useState<"categories" | "feeds" | "search">("categories");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedQuery = useDebounce(searchQuery, 300);

  const { data: categoriesData, isLoading: loadingCategories } = useDiscoveryCategories();
  const { data: catalogData, isLoading: loadingCatalog } = useDiscoveryCatalog(
    selectedCategory,
    undefined,
    mode === "feeds"
  );
  const {
    data: searchData,
    isLoading: loadingSearch,
    error: searchError,
  } = useDiscoverySearch(debouncedQuery, mode === "search" && debouncedQuery.length >= 2);

  const handleCategorySelect = (categoryId: string) => {
    setSelectedCategory(categoryId);
    setMode("feeds");
  };

  const handleBack = () => {
    setMode("categories");
    setSelectedCategory(null);
  };

  const handleSearchFocus = () => {
    if (searchQuery.length >= 2) {
      setMode("search");
    }
  };

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (value.length >= 2) {
      setMode("search");
    } else if (mode === "search") {
      setMode("categories");
    }
  };

  const categories = categoriesData?.categories || [];
  const catalogFeeds = catalogData?.feeds || [];
  const searchFeeds = searchData?.feeds || [];
  const searchHint = searchData?.hint;
  const hasEmptyCatalog = categories.every((c) => c.feedCount === 0);

  return (
    <div className="space-y-3">
      {/* Search Input */}
      <div className="relative">
        <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t("searchPlaceholder")}
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          onFocus={handleSearchFocus}
          className="h-9 ps-9 text-sm"
        />
      </div>

      {/* Content Area */}
      <ScrollArea className="h-[280px]">
        {mode === "search" ? (
          <SearchResults
            query={debouncedQuery}
            feeds={searchFeeds}
            isLoading={loadingSearch}
            error={searchError}
            hint={searchHint}
            onAddFeed={onAddFeed}
            isAddingFeed={isAddingFeed}
            addingUrl={addingUrl}
            subscribedUrls={subscribedUrls}
          />
        ) : mode === "feeds" ? (
          <FeedList
            feeds={catalogFeeds}
            isLoading={loadingCatalog}
            onBack={handleBack}
            categoryName={
              categories.find((c) => c.id === selectedCategory)?.name || ""
            }
            onAddFeed={onAddFeed}
            isAddingFeed={isAddingFeed}
            addingUrl={addingUrl}
            subscribedUrls={subscribedUrls}
          />
        ) : (
          <CategoryGrid
            categories={categories}
            isLoading={loadingCategories}
            onSelect={handleCategorySelect}
            isEmpty={hasEmptyCatalog}
          />
        )}
      </ScrollArea>
    </div>
  );
}

function CategoryGrid({
  categories,
  isLoading,
  onSelect,
  isEmpty,
}: {
  categories: { id: string; name: string; icon: string; feedCount: number }[];
  isLoading: boolean;
  onSelect: (id: string) => void;
  isEmpty: boolean;
}) {
  const t = useTranslations("discovery");
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Globe className="size-5 text-muted-foreground/50 mb-2" />
        <p className="text-sm text-muted-foreground">
          {t("catalogEmpty")}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {t("useSearchHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {categories
        .filter((c) => c.feedCount > 0)
        .map((category) => (
          <button
            key={category.id}
            onClick={() => onSelect(category.id)}
            className={cn(
              "ui-control-surface flex items-center gap-2 rounded-xl border px-3 py-2.5",
              "transition-colors text-start"
            )}
          >
            <span className="text-lg">{category.icon}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{category.name}</p>
              <p className="text-xs text-muted-foreground">
                {t("feedsInCategory", { count: category.feedCount })}
              </p>
            </div>
          </button>
        ))}
    </div>
  );
}

function FeedList({
  feeds,
  isLoading,
  onBack,
  categoryName,
  onAddFeed,
  isAddingFeed,
  addingUrl,
  subscribedUrls,
}: {
  feeds: CatalogFeed[];
  isLoading: boolean;
  onBack: () => void;
  categoryName: string;
  onAddFeed: (url: string, title?: string) => void;
  isAddingFeed: boolean;
  addingUrl: string | null;
  subscribedUrls: Set<string>;
}) {
  const t = useTranslations("discovery");
  return (
    <div className="space-y-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="h-9 px-3 -ms-3 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4 me-1.5 rtl:rotate-180" />
        {t("backToCategories")}
      </Button>
      <p className="text-xs font-medium text-muted-foreground px-0.5">
        {categoryName}
      </p>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : feeds.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {t("noFeedsInCategory")}
        </div>
      ) : (
        <div className="space-y-1.5">
          {feeds.map((feed) => (
            <FeedCard
              key={feed.id}
              feed={feed}
              onAdd={() => onAddFeed(feed.url, feed.title)}
              isAdding={isAddingFeed && addingUrl === feed.url}
              isSubscribed={subscribedUrls.has(feed.url)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SearchResults({
  query,
  feeds,
  isLoading,
  error,
  hint,
  onAddFeed,
  isAddingFeed,
  addingUrl,
  subscribedUrls,
}: {
  query: string;
  feeds: DiscoveryFeed[];
  isLoading: boolean;
  error: Error | null;
  hint?: string;
  onAddFeed: (url: string, title?: string) => void;
  isAddingFeed: boolean;
  addingUrl: string | null;
  subscribedUrls: Set<string>;
}) {
  const t = useTranslations("discovery");
  if (query.length < 2) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {t("minCharsToSearch")}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ms-2 text-sm text-muted-foreground">{t("searching")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <AlertCircle className="size-5 text-amber-500 mb-2" />
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  if (feeds.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-muted-foreground">
          {hint || t("noFeedsFound")}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {t("tryTopics")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground px-0.5">
        {feeds.length} {t("feedsFound")}
      </p>
      {feeds.map((feed, i) => (
        <FeedCard
          key={`${feed.url}-${i}`}
          feed={{
            id: feed.url,
            url: feed.url,
            title: feed.title,
            description: feed.description,
            iconUrl: feed.iconUrl,
            category: "",
            language: "",
            popularity: 0,
          }}
          onAdd={() => onAddFeed(feed.url, feed.title)}
          isAdding={isAddingFeed && addingUrl === feed.url}
          isSubscribed={subscribedUrls.has(feed.url)}
        />
      ))}
    </div>
  );
}

function FeedCard({
  feed,
  onAdd,
  isAdding,
  isSubscribed,
}: {
  feed: CatalogFeed;
  onAdd: () => void;
  isAdding: boolean;
  isSubscribed: boolean;
}) {
  const t = useTranslations("discovery");
  return (
    <div className="ui-control-surface relative rounded-xl border px-2.5 py-2 pe-10 overflow-hidden w-full">
      <div className="flex items-center gap-2 min-w-0">
        {feed.iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={feed.iconUrl}
            alt=""
            className="h-4 w-4 rounded object-cover shrink-0"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <Rss className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        <p className="text-sm font-medium truncate" title={feed.title}>
          {feed.title}
        </p>
      </div>
      {feed.description && (
        <p
          className="text-xs text-muted-foreground mt-0.5 pe-1"
          style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {feed.description}
        </p>
      )}
      <Button
        size="sm"
        variant={isSubscribed ? "ghost" : "ghost"}
        className={cn(
          "absolute end-1.5 top-1.5 h-7 w-7 p-0 rounded-lg shrink-0",
          isSubscribed && "text-green-500 cursor-default"
        )}
        onClick={isSubscribed ? undefined : onAdd}
        disabled={isAdding || isSubscribed}
        title={isSubscribed ? t("alreadyAdded") : t("addFeed")}
      >
        {isAdding ? (
          <Loader2 className="size-4 animate-spin" />
        ) : isSubscribed ? (
          <Check className="size-4" />
        ) : (
          <Plus className="size-4" />
        )}
      </Button>
    </div>
  );
}
