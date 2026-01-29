"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { FeedSource, categories } from "@/lib/rss-data";
import {
  Home,
  Star,
  Clock,
  Archive,
  Plus,
  ChevronDown,
  Search,
  Settings as SettingsIcon,
  Rss,
  LogOut,
  User as UserIcon,
  Shield,
  Folder,
  Edit2,
  Trash2,
  Download,
  Upload,
} from "lucide-react";
import { useSession, signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ThemeToggle } from "@/components/theme-toggle";
import { FeedManagement } from "./feed-management";
import { SettingsDialog } from "./settings-dialog";
import { addFeed } from "@/app/actions/feeds";
import { useAddFeed } from "@/hooks/use-rss-data";

interface RssSidebarProps {
  feeds: FeedSource[];
  selectedFeed: string | null;
  selectedCategory: string;
  onSelectFeed: (feedId: string | null) => void;
  onSelectCategory: (category: string) => void;
  isCollapsed?: boolean;
}

export function RssSidebar({
  feeds,
  selectedFeed,
  selectedCategory,
  onSelectFeed,
  onSelectCategory,
  isCollapsed = false,
}: RssSidebarProps) {
  const [expandedCategories, setExpandedCategories] = useState<string[]>([
    "Technology",
    "Design",
  ]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isManagementOpen, setIsManagementOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAddFeedOpen, setIsAddFeedOpen] = useState(false);
  const [newFeedUrl, setNewFeedUrl] = useState("");
  const [isAddingFeed, setIsAddingFeed] = useState(false);

  const addNewFeed = useAddFeed();

  const groupedFeeds = feeds.reduce(
    (acc, feed) => {
      if (!acc[feed.category]) {
        acc[feed.category] = [];
      }
      acc[feed.category].push(feed);
      return acc;
    },
    {} as Record<string, FeedSource[]>,
  );

  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) =>
      prev.includes(category)
        ? prev.filter((c) => c !== category)
        : [...prev, category],
    );
  };

  const filteredFeeds = searchQuery
    ? feeds.filter((f) =>
        f.name.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : null;

  const totalUnread = feeds.reduce((sum, f) => sum + f.unreadCount, 0);

  const navItems = [
    { id: "all", icon: Home, label: "All Articles", count: totalUnread },
    { id: "starred", icon: Star, label: "Starred", count: 3 },
    { id: "recent", icon: Clock, label: "Recently Read", count: null },
    { id: "archive", icon: Archive, label: "Archive", count: null },
  ];

  const { data: session } = useSession();

  if (isCollapsed) {
    return (
      <aside className="w-20 h-full bg-sidebar border-r border-sidebar-border flex flex-col items-center py-6 gap-3">
        <div className="mb-6 shadow-sm transition-transform duration-300 hover:scale-105">
          <img
            src="/logo.svg"
            alt="Logo"
            className="w-10 h-10 invert dark:invert-0"
          />
        </div>
        {navItems.map((item, index) => (
          <Button
            key={item.id}
            variant="ghost"
            size="icon"
            style={{ animationDelay: `${index * 50}ms` }}
            className={cn(
              "w-12 h-12 rounded-xl relative transition-all duration-200 hover:scale-105 active:scale-95 animate-fade-in",
              selectedFeed === null &&
                selectedCategory === (item.id === "all" ? "All" : item.id) &&
                "bg-sidebar-accent",
            )}
            onClick={() => {
              onSelectFeed(null);
              if (item.id === "all") onSelectCategory("All");
            }}
          >
            <item.icon className="w-5 h-5 text-sidebar-foreground" />
            {item.count && item.count > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-accent text-accent-foreground text-xs flex items-center justify-center font-semibold shadow-sm">
                {item.count > 9 ? "9+" : item.count}
              </span>
            )}
          </Button>
        ))}
      </aside>
    );
  }

  return (
    <aside className="w-80 h-full bg-sidebar border-r border-sidebar-border flex flex-col animate-slide-in-right">
      {/* Header */}
      <div className="p-5 border-b border-sidebar-border">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-4">
            <div className="transition-transform duration-300 hover:scale-105">
              <img
                src="/logo.svg"
                alt="FeedFerret Logo"
                className="w-12 h-12 invert dark:invert-0"
              />
            </div>
            <div>
              <h1 className="text-xl font-bold text-sidebar-foreground tracking-tight">
                FeedFerret
              </h1>
              <p className="text-sm text-muted-foreground">
                {totalUnread} unread articles
              </p>
            </div>
          </div>
          <ThemeToggle />
        </div>
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            placeholder="Search feeds..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-11 h-12 text-base bg-sidebar-accent border-0 rounded-xl focus-visible:ring-2 focus-visible:ring-sidebar-ring transition-all duration-200"
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Navigation */}
          <nav className="space-y-1.5 mb-8">
            {navItems.map((item, index) => (
              <button
                key={item.id}
                style={{ animationDelay: `${index * 50}ms` }}
                onClick={() => {
                  onSelectFeed(null);
                  if (item.id === "all") onSelectCategory("All");
                }}
                className={cn(
                  "w-full flex items-center gap-4 px-4 py-3 rounded-xl text-base transition-all duration-200 animate-fade-in-up",
                  "hover:scale-[1.02] active:scale-[0.98]",
                  selectedFeed === null &&
                    selectedCategory === "All" &&
                    item.id === "all"
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold shadow-sm"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                )}
              >
                <item.icon className="w-5 h-5" />
                <span className="flex-1 text-left">{item.label}</span>
                {item.count !== null && item.count > 0 && (
                  <span className="text-sm tabular-nums text-muted-foreground bg-muted px-2.5 py-1 rounded-lg font-medium">
                    {item.count}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {/* Feeds */}
          <div className="space-y-5">
            <div className="flex items-center justify-between px-4">
              <span className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                Feeds
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="w-8 h-8 rounded-lg transition-all duration-200 hover:scale-110 active:scale-95"
                onClick={() => setIsAddFeedOpen(true)}
              >
                <Plus className="w-5 h-5" />
              </Button>
            </div>

            {isAddFeedOpen && (
              <div className="px-4 py-2 space-y-2 animate-in slide-in-from-top-2 duration-200">
                <Input
                  placeholder="Feed URL (RSS/Atom)..."
                  value={newFeedUrl}
                  onChange={(e) => setNewFeedUrl(e.target.value)}
                  className="h-10 text-sm bg-sidebar-accent border-0"
                  onKeyDown={async (e) => {
                    if (e.key === "Enter" && newFeedUrl) {
                      setIsAddingFeed(true);
                      await addFeed(newFeedUrl);
                      setNewFeedUrl("");
                      setIsAddFeedOpen(false);
                      setIsAddingFeed(false);
                    }
                  }}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1 h-8 text-xs"
                    disabled={!newFeedUrl || isAddingFeed}
                    onClick={async () => {
                      setIsAddingFeed(true);
                      await addFeed(newFeedUrl);
                      setNewFeedUrl("");
                      setIsAddFeedOpen(false);
                      setIsAddingFeed(false);
                    }}
                  >
                    Add
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="flex-1 h-8 text-xs"
                    onClick={() => {
                      setIsAddFeedOpen(false);
                      setNewFeedUrl("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {filteredFeeds ? (
              <div className="space-y-1">
                {filteredFeeds.map((feed, index) => (
                  <FeedItem
                    key={feed.id}
                    feed={feed}
                    isSelected={selectedFeed === feed.id}
                    onSelect={() => onSelectFeed(feed.id)}
                    index={index}
                  />
                ))}
                {filteredFeeds.length === 0 && (
                  <p className="text-base text-muted-foreground px-4 py-3">
                    No feeds found
                  </p>
                )}
              </div>
            ) : (
              Object.entries(groupedFeeds).map(
                ([category, categoryFeeds], categoryIndex) => (
                  <div
                    key={category}
                    style={{ animationDelay: `${categoryIndex * 100}ms` }}
                    className="animate-fade-in"
                  >
                    <button
                      onClick={() => toggleCategory(category)}
                      className="w-full flex items-center gap-3 px-4 py-2 text-sm font-semibold text-muted-foreground hover:text-sidebar-foreground transition-colors duration-200"
                    >
                      <ChevronDown
                        className={cn(
                          "w-4 h-4 transition-transform duration-300",
                          !expandedCategories.includes(category) &&
                            "-rotate-90",
                        )}
                      />
                      {category}
                      <span className="ml-auto tabular-nums text-xs bg-muted px-2 py-0.5 rounded-md">
                        {categoryFeeds.reduce(
                          (sum, f) => sum + f.unreadCount,
                          0,
                        )}
                      </span>
                    </button>
                    <div
                      className={cn(
                        "mt-1 space-y-0.5 overflow-hidden transition-all duration-300",
                        expandedCategories.includes(category)
                          ? "max-h-[500px] opacity-100"
                          : "max-h-0 opacity-0",
                      )}
                    >
                      {categoryFeeds.map((feed, feedIndex) => (
                        <FeedItem
                          key={feed.id}
                          feed={feed}
                          isSelected={selectedFeed === feed.id}
                          onSelect={() => onSelectFeed(feed.id)}
                          index={feedIndex}
                        />
                      ))}
                    </div>
                  </div>
                ),
              )
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="p-4 border-t border-sidebar-border space-y-2">
        {session?.user && (
          <div className="flex items-center gap-3 px-4 py-3 mb-2 bg-sidebar-accent/30 rounded-xl">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary">
              <UserIcon className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sidebar-foreground truncate">
                {session.user.name || session.user.email}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="w-8 h-8 text-muted-foreground hover:text-primary transition-colors"
              onClick={() => setIsSettingsOpen(true)}
            >
              <SettingsIcon className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="w-8 h-8 text-muted-foreground hover:text-destructive transition-colors"
              onClick={() => signOut()}
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        )}
        <Button
          variant="ghost"
          className="w-full justify-start gap-4 h-12 text-base text-muted-foreground hover:text-sidebar-foreground rounded-xl transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
          onClick={() => setIsManagementOpen(true)}
        >
          <SettingsIcon className="w-5 h-5" />
          Manage Feeds
        </Button>
        <FeedManagement
          open={isManagementOpen}
          onOpenChange={setIsManagementOpen}
        />
        <SettingsDialog
          open={isSettingsOpen}
          onOpenChange={setIsSettingsOpen}
        />
      </div>
    </aside>
  );
}

function FeedItem({
  feed,
  isSelected,
  onSelect,
  index,
}: {
  feed: FeedSource;
  isSelected: boolean;
  onSelect: () => void;
  index: number;
}) {
  return (
    <button
      onClick={onSelect}
      style={{ animationDelay: `${index * 30}ms` }}
      className={cn(
        "w-full flex items-center gap-4 px-4 py-3 rounded-xl text-base transition-all duration-200 animate-fade-in",
        "hover:scale-[1.02] active:scale-[0.98]",
        isSelected
          ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
          : "text-sidebar-foreground hover:bg-sidebar-accent/50",
      )}
    >
      <span className="text-xl">{feed.icon}</span>
      <span className="flex-1 text-left truncate font-medium">{feed.name}</span>
      {feed.unreadCount > 0 && (
        <span className="text-sm tabular-nums text-muted-foreground font-medium">
          {feed.unreadCount}
        </span>
      )}
    </button>
  );
}
