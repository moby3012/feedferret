"use client";

import { useTranslations, useFormatter } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  RefreshCw,
  LayoutGrid,
  List,
  SortAsc,
  SortDesc,
  Filter,
  AlignJustify,
  CheckCheck,
  BookmarkPlus,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

export type ViewMode = "list" | "magazine" | "minimal";

interface RssHeaderProps {
  title: string;
  articleCount: number;
  unreadCount?: number;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onToggleSidebar: () => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  onMarkAllRead?: () => void;
  isMarkingAllRead?: boolean;
  onSaveSearch?: () => void;
  onShowShortcuts?: () => void;
  sortOrder?: "newest" | "oldest";
  onToggleSort?: () => void;
  onSwipeNextFeed?: () => void;
  onSwipePreviousFeed?: () => void;
}

export function RssHeader({
  title,
  articleCount,
  unreadCount,
  viewMode,
  onViewModeChange,
  onToggleSidebar,
  onRefresh,
  isRefreshing,
  unreadOnly,
  onToggleUnreadOnly,
  searchQuery = "",
  onSearchChange,
  onMarkAllRead,
  isMarkingAllRead,
  onSaveSearch,
  onShowShortcuts,
  sortOrder = "newest",
  onToggleSort,
  onSwipeNextFeed,
  onSwipePreviousFeed,
}: RssHeaderProps) {
  const t = useTranslations("rssHeader");
  const format = useFormatter();
  const activeViewMode: ViewMode =
    viewMode === "minimal" || viewMode === "magazine" ? viewMode : "list";

  const displayCount = unreadCount ?? articleCount;

  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const prevIsRefreshing = useRef(false);
  useEffect(() => {
    if (prevIsRefreshing.current && !isRefreshing) setLastRefreshed(new Date());
    prevIsRefreshing.current = !!isRefreshing;
  }, [isRefreshing]);

  const lastRefreshedLabel = lastRefreshed
    ? `${t("lastSynced")} ${format.dateTime(lastRefreshed, { hour: "2-digit", minute: "2-digit" })}`
    : t("refreshFeeds");

  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const handleTitleSwipeStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    swipeStart.current = { x: t.clientX, y: t.clientY };
  };
  const handleTitleSwipeEnd = (e: React.TouchEvent) => {
    if (!swipeStart.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipeStart.current.x;
    const dy = t.clientY - swipeStart.current.y;
    swipeStart.current = null;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    
    const isRtl = typeof document !== "undefined" && document.documentElement.getAttribute("dir") === "rtl";
    const goNext = isRtl ? dx > 0 : dx < 0;
    if (goNext) onSwipeNextFeed?.();
    else onSwipePreviousFeed?.();
  };

  return (
    <header className="min-h-16 flex items-center justify-between px-4 sm:px-5 pt-[env(safe-area-inset-top)] border-b border-border/60 bg-card/75 backdrop-blur-2xl animate-fade-in relative z-20">
      <div
        className="flex items-center gap-3 min-w-0 flex-1"
        onTouchStart={handleTitleSwipeStart}
        onTouchEnd={handleTitleSwipeEnd}
      >
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground tracking-[-0.02em] truncate">
            {title}
          </h2>
          <p className="text-xs text-muted-foreground truncate font-medium">
            <span className={cn("tabular-nums", displayCount > 0 && "text-brand font-semibold")}>
              {displayCount}
            </span>{" "}
            unread
          </p>
        </div>
      </div>

      {/* Mobile: sort + view cycle */}
      <div className="flex items-center gap-1 lg:hidden flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="w-11 h-11 rounded-xl transition-all duration-200 active:scale-95 text-muted-foreground"
          onClick={() => onToggleSort?.()}
          aria-label={sortOrder === "oldest" ? t("sortOldest") : t("sortNewest")}
          title={sortOrder === "oldest" ? t("sortOldest") : t("sortNewest")}
        >
          {sortOrder === "oldest" ? <SortAsc className="w-4 h-4" /> : <SortDesc className="w-4 h-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="w-11 h-11 rounded-xl transition-all duration-200 active:scale-95"
          onClick={() => {
            const modes: ViewMode[] = ["list", "minimal", "magazine"];
            const idx = modes.indexOf(activeViewMode);
            onViewModeChange(modes[(idx + 1) % modes.length]);
          }}
          aria-label={`View mode: ${activeViewMode} (click to cycle)`}
          title={`View: ${activeViewMode} (click to cycle)`}
        >
          {activeViewMode === "minimal" && <AlignJustify className="w-4 h-4" />}
          {activeViewMode === "list" && <List className="w-4 h-4" />}
          {activeViewMode === "magazine" && <LayoutGrid className="w-4 h-4" />}
        </Button>
      </div>

      {/* Desktop: responsive button bar */}
      <div className="hidden items-center gap-0.5 lg:flex xl:gap-1 flex-shrink-0">
        {/* Filter – always visible */}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95",
            unreadOnly
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground",
          )}
          onClick={onToggleUnreadOnly}
          aria-pressed={unreadOnly}
          aria-label={unreadOnly ? t("showingUnreadOnly") : t("showUnreadOnly")}
          title={unreadOnly ? t("showingUnreadOnly") : t("showUnreadOnly")}
        >
          <Filter className="w-4 h-4" />
        </Button>

        {/* Refresh – always visible */}
        <Button
          variant="ghost"
          size="icon"
          className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95 text-muted-foreground"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label={isRefreshing ? t("refreshing") : lastRefreshedLabel}
          title={isRefreshing ? t("refreshing") : lastRefreshedLabel}
        >
          <RefreshCw
            className={cn(
              "w-4 h-4 transition-transform duration-500",
              isRefreshing && "animate-spin",
            )}
          />
        </Button>

        {/* Sort – visible at xl+, hidden at lg-xl */}
        <Button
          variant="ghost"
          size="icon"
          className="hidden xl:inline-flex w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95 text-muted-foreground"
          onClick={() => onToggleSort?.()}
          aria-label={sortOrder === "oldest" ? t("sortOldest") : t("sortNewest")}
          title={sortOrder === "oldest" ? t("sortOldest") : t("sortNewest")}
        >
          {sortOrder === "oldest" ? (
            <SortAsc className="w-4 h-4" />
          ) : (
            <SortDesc className="w-4 h-4" />
          )}
        </Button>

        {/* Mark all read – visible at xl+, hidden at lg-xl */}
        <Button
          variant="ghost"
          size="icon"
          className="hidden xl:inline-flex w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95 text-muted-foreground"
          onClick={() => onMarkAllRead?.()}
          disabled={isMarkingAllRead}
          aria-label={t("markAllAsRead")}
          title={t("markAllAsRead")}
        >
          <CheckCheck className={cn("w-4 h-4", isMarkingAllRead && "animate-pulse")} />
        </Button>

        {/* Save search – visible at xl+ when active search */}
        {searchQuery.trim() && onSaveSearch && (
          <Button
            variant="ghost"
            size="icon"
            className="hidden xl:inline-flex w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95 text-muted-foreground"
            onClick={onSaveSearch}
            aria-label={t("saveSearch")}
            title={t("saveSearch")}
          >
            <BookmarkPlus className="w-4 h-4" />
          </Button>
        )}

        {/* View cycling – always visible */}
        <Button
          variant="ghost"
          size="icon"
          className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
          onClick={() => {
            const modes: ViewMode[] = ["list", "minimal", "magazine"];
            const idx = modes.indexOf(activeViewMode);
            onViewModeChange(modes[(idx + 1) % modes.length]);
          }}
          aria-label={`View mode: ${activeViewMode} (click to cycle)`}
          title={`View: ${activeViewMode} (click to cycle)`}
        >
          {activeViewMode === "minimal" && <AlignJustify className="w-4 h-4" />}
          {activeViewMode === "list" && <List className="w-4 h-4" />}
          {activeViewMode === "magazine" && <LayoutGrid className="w-4 h-4" />}
        </Button>

        {/* Overflow dropdown – visible at lg-xl, hidden at xl+ */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="xl:hidden w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95 text-muted-foreground"
              aria-label={t("moreOptions")}
              title={t("moreOptions")}
            >
              <MoreHorizontal className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 rounded-2xl border-border/70 p-2">
            <DropdownMenuItem
              className="rounded-xl gap-2 cursor-pointer"
              onClick={() => onToggleSort?.()}
            >
              {sortOrder === "oldest" ? (
                <SortAsc className="w-4 h-4" />
              ) : (
                <SortDesc className="w-4 h-4" />
              )}
              {sortOrder === "oldest" ? t("sortOldest") : t("sortNewest")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="rounded-xl gap-2 cursor-pointer"
              onClick={() => onMarkAllRead?.()}
              disabled={isMarkingAllRead}
            >
              <CheckCheck className="w-4 h-4" />
              {t("markAllAsRead")}
            </DropdownMenuItem>
            {searchQuery.trim() && onSaveSearch && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="rounded-xl gap-2 cursor-pointer"
                  onClick={onSaveSearch}
                >
                  <BookmarkPlus className="w-4 h-4" />
                  {t("saveSearch")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
