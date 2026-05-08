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
  Filter,
  MoreHorizontal,
  AlignJustify,
  Check,
  Search,
  X,
  CheckCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { useState } from "react";

export type ViewMode = "list" | "magazine" | "minimal";

interface RssHeaderProps {
  title: string;
  articleCount: number;
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
}

export function RssHeader({
  title,
  articleCount,
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
}: RssHeaderProps) {
  const [showSearch, setShowSearch] = useState(!!searchQuery);

  return (
    <header className="h-16 flex items-center justify-between px-5 border-b border-border bg-card/80 backdrop-blur-xl animate-fade-in relative z-20">
      <div className="flex items-center gap-4 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          className="w-10 h-10 rounded-xl lg:hidden transition-all duration-200 hover:scale-105 active:scale-95"
          onClick={onToggleSidebar}
        >
          <PanelLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold text-foreground tracking-tight truncate">
            {title}
          </h2>
          <p className="text-xs text-muted-foreground truncate font-medium">
            {articleCount} {unreadOnly ? "unread " : ""}articles
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
        {/* Search Toggle */}
        {onSearchChange && (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95",
              showSearch || searchQuery
                ? "text-blue-500 bg-blue-500/10"
                : "text-muted-foreground"
            )}
            onClick={() => {
              setShowSearch(!showSearch);
              if (showSearch) {
                onSearchChange("");
              }
            }}
          >
            {showSearch || searchQuery ? <X className="w-4 h-4" /> : <Search className="w-4 h-4" />}
          </Button>
        )}

        {/* Search Input */}
        {showSearch && onSearchChange && (
          <Input
            type="search"
            placeholder="Search articles..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-10 w-40 lg:w-60 rounded-xl bg-background/50 border-border/50 focus:bg-background"
            autoFocus
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-10 rounded-xl px-3 transition-all duration-200 hover:scale-105 active:scale-95 flex items-center gap-2",
            unreadOnly
              ? "text-blue-500 bg-blue-500/10 border border-blue-500/20 shadow-sm"
              : "text-muted-foreground",
          )}
          onClick={onToggleUnreadOnly}
        >
          <Filter className="w-4 h-4" />
          {unreadOnly && (
            <span className="text-xs font-bold uppercase tracking-wider">
              Unread Only
            </span>
          )}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
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

        <div className="hidden sm:flex items-center border border-border rounded-xl p-1 bg-muted/50">
          <Button
            variant={viewMode === "minimal" ? "secondary" : "ghost"}
            size="icon"
            className="w-8 h-8 rounded-lg transition-all"
            onClick={() => onViewModeChange("minimal")}
          >
            <AlignJustify className="w-4 h-4" />
          </Button>
          <Button
            variant={viewMode === "list" ? "secondary" : "ghost"}
            size="icon"
            className="w-8 h-8 rounded-lg transition-all"
            onClick={() => onViewModeChange("list")}
          >
            <List className="w-4 h-4" />
          </Button>
          <Button
            variant={viewMode === "magazine" ? "secondary" : "ghost"}
            size="icon"
            className="w-8 h-8 rounded-lg transition-all"
            onClick={() => onViewModeChange("magazine")}
          >
            <LayoutGrid className="w-4 h-4" />
          </Button>
        </div>

        <div className="lg:hidden">
          <ThemeToggle />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
            >
              <MoreHorizontal className="w-5 h-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-56 rounded-2xl p-2 shadow-2xl border-none bg-popover/95 backdrop-blur-xl"
          >
            <DropdownMenuItem
              className="rounded-xl py-3 px-4 text-sm font-medium focus:bg-primary focus:text-primary-foreground"
              onClick={onToggleUnreadOnly}
            >
              <Filter className="w-4 h-4 mr-3" />
              Filter unread only
              {unreadOnly && <Check className="w-4 h-4 ml-auto" />}
            </DropdownMenuItem>

            <DropdownMenuSeparator className="my-2 bg-border/50" />

            <DropdownMenuItem className="rounded-xl py-3 px-4 text-sm font-medium">
              <SortAsc className="w-4 h-4 mr-3" />
              Sort by date
            </DropdownMenuItem>

            <DropdownMenuItem 
              className="rounded-xl py-3 px-4 text-sm font-medium text-destructive focus:bg-destructive/10 focus:text-destructive"
              onClick={() => {
                if (confirm("Mark all articles in the current view as read?")) {
                  onMarkAllRead?.();
                }
              }}
              disabled={isMarkingAllRead}
            >
              <CheckCheck className="w-4 h-4 mr-3" />
              {isMarkingAllRead ? "Marking..." : "Mark all as read"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
