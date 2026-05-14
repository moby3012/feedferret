"use client";

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
  PanelLeft,
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
import { useState } from "react";

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
}: RssHeaderProps) {
  const activeViewMode: ViewMode =
    viewMode === "minimal" || viewMode === "magazine" ? viewMode : "list";

  const displayCount = unreadCount ?? articleCount;

  return (
    <header className="h-16 flex items-center justify-between px-4 sm:px-5 border-b border-border/60 bg-card/75 backdrop-blur-2xl animate-fade-in relative z-20">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <Button
          variant="ghost"
          size="icon"
          className="w-10 h-10 rounded-xl lg:hidden shrink-0 transition-all duration-200 hover:scale-105 active:scale-95"
          onClick={onToggleSidebar}
        >
          <PanelLeft className="w-5 h-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground tracking-[-0.02em] truncate">
            {title}
          </h2>
          <p className="text-xs text-muted-foreground truncate font-medium">
            {displayCount} unread
          </p>
        </div>
      </div>

      {/* Mobile: view cycle only */}
      <div className="flex items-center gap-1 lg:hidden flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="w-10 h-10 rounded-xl transition-all duration-200 active:scale-95"
          onClick={() => {
            const modes: ViewMode[] = ["list", "minimal", "magazine"];
            const idx = modes.indexOf(activeViewMode);
            onViewModeChange(modes[(idx + 1) % modes.length]);
          }}
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
              ? "text-accent bg-accent/10"
              : "text-muted-foreground",
          )}
          onClick={onToggleUnreadOnly}
          title={unreadOnly ? "Showing unread only (click to show all)" : "Show unread only"}
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
          title={sortOrder === "oldest" ? "Sort: oldest first" : "Sort: newest first"}
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
          title="Mark all as read"
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
            title="Save search"
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
              title="More options"
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
              Sort: {sortOrder === "oldest" ? "oldest first" : "newest first"}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="rounded-xl gap-2 cursor-pointer"
              onClick={() => onMarkAllRead?.()}
              disabled={isMarkingAllRead}
            >
              <CheckCheck className="w-4 h-4" />
              Mark all as read
            </DropdownMenuItem>
            {searchQuery.trim() && onSaveSearch && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="rounded-xl gap-2 cursor-pointer"
                  onClick={onSaveSearch}
                >
                  <BookmarkPlus className="w-4 h-4" />
                  Save search
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
