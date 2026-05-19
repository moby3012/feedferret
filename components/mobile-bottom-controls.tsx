"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  CheckCheck,
  PanelLeft,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

interface MobileBottomControlsProps {
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  onToggleSidebar: () => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onMarkAllRead?: () => void;
  isMarkingAllRead?: boolean;
}

const mobileButtonClass =
  "h-11 w-11 shrink-0 rounded-2xl text-muted-foreground active:scale-95";

export function MobileBottomControls({
  unreadOnly,
  onToggleUnreadOnly,
  onToggleSidebar,
  onRefresh,
  isRefreshing,
  searchQuery,
  onSearchChange,
  onMarkAllRead,
  isMarkingAllRead,
}: MobileBottomControlsProps) {
  const [searchOpen, setSearchOpen] = useState(!!searchQuery);

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
            "h-10 min-w-0 flex-1 rounded-2xl px-3 text-xs font-bold uppercase tracking-[0.16em] active:scale-[0.98] transition-all duration-200",
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
          className={cn(mobileButtonClass, isMarkingAllRead && "text-accent")}
          disabled={isMarkingAllRead}
          onClick={() => onMarkAllRead?.()}
          aria-label="Mark all articles as read"
          title="Mark all as read"
        >
          <CheckCheck className={cn("h-5 w-5", isMarkingAllRead && "animate-pulse")} />
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
      </nav>
    </div>
  );
}
