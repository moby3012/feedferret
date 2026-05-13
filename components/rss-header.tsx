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
  Search,
  X,
  CheckCheck,
  BookmarkPlus,
  Bell,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { useState } from "react";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationCount,
} from "@/hooks/use-rss-data";

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
  onSaveSearch?: () => void;
  onShowShortcuts?: () => void;
  sortOrder?: "newest" | "oldest";
  onToggleSort?: () => void;
}

function NotificationsMenuButton({
  unreadNotifications,
  notifications,
  onMarkNotificationRead,
  onMarkAllNotificationsRead,
  className,
}: {
  unreadNotifications: number;
  notifications: any[];
  onMarkNotificationRead: (id: string) => void;
  onMarkAllNotificationsRead: () => void;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95 relative",
            unreadNotifications ? "text-accent bg-accent/10" : "text-muted-foreground",
            className,
          )}
        >
          <Bell className="w-4 h-4" />
          {unreadNotifications > 0 && (
            <span className="absolute right-1.5 top-1.5 min-w-4 rounded-full bg-destructive px-1 text-[10px] font-bold leading-4 text-destructive-foreground">
              {unreadNotifications > 9 ? "9+" : unreadNotifications}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 rounded-2xl border-border/70 p-2">
        <div className="flex items-center justify-between px-2 py-1.5">
          <p className="text-sm font-semibold">Notifications</p>
          {unreadNotifications > 0 && (
            <button
              className="text-xs text-primary hover:underline"
              onClick={onMarkAllNotificationsRead}
            >
              Mark all read
            </button>
          )}
        </div>
        <DropdownMenuSeparator />
        {notifications.length === 0 ? (
          <div className="px-2 py-8 text-center text-sm text-muted-foreground">
            No notifications yet.
          </div>
        ) : (
          notifications.slice(0, 8).map((notification: any) => (
            <DropdownMenuItem
              key={notification.id}
              className="items-start gap-3 rounded-xl px-2 py-2"
              onClick={() => {
                if (!notification.isRead) onMarkNotificationRead(notification.id);
                if (notification.articleId) {
                  window.location.href = `/?article=${encodeURIComponent(notification.articleId)}`;
                }
              }}
            >
              <span
                className={cn(
                  "mt-1 h-2 w-2 shrink-0 rounded-full",
                  notification.isRead ? "bg-muted" : "bg-accent",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{notification.title}</span>
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {notification.body}
                </span>
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
  onSaveSearch,
  onShowShortcuts,
  sortOrder = "newest",
  onToggleSort,
}: RssHeaderProps) {
  const [showSearch, setShowSearch] = useState(!!searchQuery);
  const { data: notifications = [] } = useNotifications();
  const { data: unreadNotifications = 0 } = useUnreadNotificationCount();
  const markNotificationRead = useMarkNotificationRead();
  const markAllNotificationsRead = useMarkAllNotificationsRead();

  return (
    <header className="h-16 flex items-center justify-between px-4 sm:px-5 border-b border-border/60 bg-card/75 backdrop-blur-2xl animate-fade-in relative z-20">
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
          <h2 className="text-base font-semibold text-foreground tracking-[-0.02em] truncate">
            {title}
          </h2>
          <p className="text-xs text-muted-foreground truncate font-medium">
            {articleCount} {unreadOnly ? "unread " : ""}articles
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 lg:hidden flex-shrink-0">
        <NotificationsMenuButton
          unreadNotifications={unreadNotifications}
          notifications={notifications}
          onMarkNotificationRead={(id) => markNotificationRead.mutate(id)}
          onMarkAllNotificationsRead={() => markAllNotificationsRead.mutate()}
        />
        <Button
          variant="ghost"
          size="icon"
          className="w-10 h-10 rounded-xl transition-all duration-200 active:scale-95"
          onClick={() => {
            const modes: ViewMode[] = ["list", "minimal", "magazine"];
            const idx = modes.indexOf(viewMode);
            onViewModeChange(modes[(idx + 1) % modes.length]);
          }}
          title={`View: ${viewMode} (click to cycle)`}
        >
          {viewMode === "minimal" && <AlignJustify className="w-4 h-4" />}
          {viewMode === "list" && <List className="w-4 h-4" />}
          {viewMode === "magazine" && <LayoutGrid className="w-4 h-4" />}
        </Button>
      </div>

      <div className="hidden items-center gap-1 lg:flex sm:gap-2 flex-shrink-0">
        {/* Search Toggle */}
        {onSearchChange && (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95",
              showSearch || searchQuery
                ? "text-accent bg-accent/10"
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
            placeholder='Search: author:, intitle:, is:unread, label:'
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-10 w-40 lg:w-60 rounded-2xl bg-background/60 border-border/50 focus:bg-background"
            autoFocus
          />
        )}
        <NotificationsMenuButton
          unreadNotifications={unreadNotifications}
          notifications={notifications}
          onMarkNotificationRead={(id) => markNotificationRead.mutate(id)}
          onMarkAllNotificationsRead={() => markAllNotificationsRead.mutate()}
        />
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
          title={unreadOnly ? "Nur Ungelesene (aktiv)" : "Nur Ungelesene anzeigen"}
        >
          <Filter className="w-4 h-4" />
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

        {/* Sort button */}
        <Button
          variant="ghost"
          size="icon"
          className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95 text-muted-foreground"
          onClick={() => onToggleSort?.()}
          title={sortOrder === "oldest" ? "Sort: oldest first" : "Sort: newest first"}
        >
          {sortOrder === "oldest" ? (
            <SortAsc className="w-4 h-4" />
          ) : (
            <SortDesc className="w-4 h-4" />
          )}
        </Button>

        {/* Mark all as read button */}
        <Button
          variant="ghost"
          size="icon"
          className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95 text-muted-foreground"
          onClick={() => onMarkAllRead?.()}
          disabled={isMarkingAllRead}
          title="Mark all as read"
        >
          <CheckCheck className={cn("w-4 h-4", isMarkingAllRead && "animate-pulse")} />
        </Button>

        {/* Save search button (only when search is active) */}
        {searchQuery.trim() && onSaveSearch && (
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95 text-muted-foreground"
            onClick={onSaveSearch}
            title="Save search"
          >
            <BookmarkPlus className="w-4 h-4" />
          </Button>
        )}

        {/* View cycling button */}
        <Button
          variant="ghost"
          size="icon"
          className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
          onClick={() => {
            const modes: ViewMode[] = ["list", "minimal", "magazine"];
            const idx = modes.indexOf(viewMode);
            onViewModeChange(modes[(idx + 1) % modes.length]);
          }}
          title={`View: ${viewMode} (click to cycle)`}
        >
          {viewMode === "minimal" && <AlignJustify className="w-4 h-4" />}
          {viewMode === "list" && <List className="w-4 h-4" />}
          {viewMode === "magazine" && <LayoutGrid className="w-4 h-4" />}
        </Button>

        <div className="lg:hidden">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
