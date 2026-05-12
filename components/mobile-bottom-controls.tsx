"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ViewMode } from "@/components/rss-header";
import {
  AlignJustify,
  Bell,
  Check,
  CheckCheck,
  Keyboard,
  LayoutGrid,
  List,
  MoreHorizontal,
  PanelLeft,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationCount,
} from "@/hooks/use-rss-data";

interface MobileBottomControlsProps {
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  onToggleSidebar: () => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onMarkAllRead?: () => void;
  isMarkingAllRead?: boolean;
  onSaveSearch?: () => void;
  onShowShortcuts?: () => void;
}

const mobileButtonClass =
  "h-11 min-w-11 rounded-2xl text-muted-foreground active:scale-95";

export function MobileBottomControls({
  unreadOnly,
  onToggleUnreadOnly,
  onToggleSidebar,
  onRefresh,
  isRefreshing,
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
  onMarkAllRead,
  isMarkingAllRead,
  onSaveSearch,
  onShowShortcuts,
}: MobileBottomControlsProps) {
  const [searchOpen, setSearchOpen] = useState(!!searchQuery);
  const { data: notifications = [] } = useNotifications();
  const { data: unreadNotifications = 0 } = useUnreadNotificationCount();
  const markNotificationRead = useMarkNotificationRead();

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden">
      {searchOpen && (
        <div className="pointer-events-auto mb-2 rounded-[1.65rem] border border-border/70 bg-background/95 p-2 shadow-2xl shadow-black/20 backdrop-blur-2xl">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search articles, author:, is:unread…"
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
              className="h-12 rounded-2xl border-border/50 bg-muted/45 pl-10 pr-11 text-base"
              autoFocus
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 h-10 w-10 -translate-y-1/2 rounded-xl"
              onClick={() => {
                if (searchQuery) onSearchChange("");
                else setSearchOpen(false);
              }}
              aria-label={searchQuery ? "Clear search" : "Close search"}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <nav className="pointer-events-auto flex h-16 items-center gap-1.5 rounded-[2rem] border border-border/70 bg-background/90 px-2 shadow-2xl shadow-black/20 backdrop-blur-2xl supports-[backdrop-filter]:bg-background/75">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={mobileButtonClass}
          onClick={onToggleSidebar}
          aria-label="Open feeds"
        >
          <PanelLeft className="h-5 w-5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={mobileButtonClass}
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label="Refresh feeds"
        >
          <RefreshCw className={cn("h-5 w-5", isRefreshing && "animate-spin")} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={cn(
            "h-11 flex-1 rounded-2xl px-3 text-xs font-bold uppercase tracking-[0.16em] active:scale-[0.98]",
            unreadOnly
              ? "bg-accent text-accent-foreground shadow-lg shadow-accent/20"
              : "bg-muted/70 text-foreground",
          )}
          onClick={onToggleUnreadOnly}
          aria-pressed={unreadOnly}
        >
          <span className={cn("h-2 w-2 rounded-full", unreadOnly ? "bg-accent-foreground" : "bg-muted-foreground")} />
          {unreadOnly ? "Unread" : "All"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            mobileButtonClass,
            (searchOpen || searchQuery) && "bg-accent/10 text-accent",
          )}
          onClick={() => setSearchOpen((open) => !open)}
          aria-label="Search articles"
        >
          <Search className="h-5 w-5" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(mobileButtonClass, "relative")}
              aria-label="More article actions"
            >
              <MoreHorizontal className="h-5 w-5" />
              {unreadNotifications > 0 && (
                <span className="absolute right-1.5 top-1.5 min-w-4 rounded-full bg-destructive px-1 text-[10px] font-bold leading-4 text-destructive-foreground">
                  {unreadNotifications > 9 ? "9+" : unreadNotifications}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={12}
            className="mb-2 w-64 rounded-3xl border-border/70 bg-popover/95 p-2 shadow-2xl backdrop-blur-xl"
          >
            <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Notifications
            </div>
            {notifications.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">No notifications yet.</div>
            ) : (
              notifications.slice(0, 3).map((notification: any) => (
                <DropdownMenuItem
                  key={notification.id}
                  className="items-start gap-2 rounded-2xl py-2.5"
                  onClick={() => {
                    if (!notification.isRead) markNotificationRead.mutate(notification.id);
                    if (notification.articleId) {
                      window.location.href = `/?article=${encodeURIComponent(notification.articleId)}`;
                    }
                  }}
                >
                  <Bell className={cn("mt-0.5 h-4 w-4 shrink-0", notification.isRead ? "text-muted-foreground" : "text-accent")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{notification.title}</span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{notification.body}</span>
                  </span>
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator className="my-2" />
            <DropdownMenuItem className="rounded-2xl py-3" onClick={() => onViewModeChange("minimal")}>
              <AlignJustify className="mr-3 h-4 w-4" />
              Compact list
              {viewMode === "minimal" && <Check className="ml-auto h-4 w-4" />}
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-2xl py-3" onClick={() => onViewModeChange("list")}>
              <List className="mr-3 h-4 w-4" />
              Comfortable list
              {viewMode === "list" && <Check className="ml-auto h-4 w-4" />}
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-2xl py-3" onClick={() => onViewModeChange("magazine")}>
              <LayoutGrid className="mr-3 h-4 w-4" />
              Magazine cards
              {viewMode === "magazine" && <Check className="ml-auto h-4 w-4" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator className="my-2" />
            {searchQuery.trim() && onSaveSearch && (
              <DropdownMenuItem className="rounded-2xl py-3" onClick={onSaveSearch}>
                <Search className="mr-3 h-4 w-4" />
                Save current search
              </DropdownMenuItem>
            )}
            {onShowShortcuts && (
              <DropdownMenuItem className="rounded-2xl py-3" onClick={onShowShortcuts}>
                <Keyboard className="mr-3 h-4 w-4" />
                Keyboard shortcuts
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="rounded-2xl py-3 text-destructive focus:text-destructive"
              disabled={isMarkingAllRead}
              onClick={() => {
                if (confirm("Mark all articles in the current view as read?")) {
                  onMarkAllRead?.();
                }
              }}
            >
              <CheckCheck className="mr-3 h-4 w-4" />
              {isMarkingAllRead ? "Marking…" : "Mark all as read"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </div>
  );
}
