"use client";

import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { FeedSource } from "@/lib/rss-data";
import {
  Home,
  Star,
  Clock,
  Archive,
  Plus,
  ChevronDown,
  Search,
  Settings as SettingsIcon,
  LogOut,
  User as UserIcon,
  Folder,
  Users,
} from "lucide-react";
import { useSession, signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ThemeToggle } from "@/components/theme-toggle";
import { FeedManagement } from "./feed-management";
import { SettingsDialog } from "./settings-dialog";
import {
  useAddFeed,
  useCategories,
  useUpdateFeedOrder,
  useUpdateCategoryOrder,
  useStarredCount,
} from "@/hooks/use-rss-data";
import { ServerManagementDialog } from "./server-management-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  defaultDropAnimationSideEffects,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";

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
  const [expandedCategories, setExpandedCategories] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isManagementOpen, setIsManagementOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAddFeedOpen, setIsAddFeedOpen] = useState(false);
  const [newFeedUrl, setNewFeedUrl] = useState("");
  const [newFeedCategoryId, setNewFeedCategoryId] = useState<string>("none");
  const [isAddingFeed, setIsAddingFeed] = useState(false);
  const [isServerManagementOpen, setIsServerManagementOpen] = useState(false);

  const addNewFeed = useAddFeed();
  const { data: allCategories = [] } = useCategories();
  const updateFeedOrder = useUpdateFeedOrder();
  const updateCategoryOrder = useUpdateCategoryOrder();
  const { data: starredCount = 0 } = useStarredCount();

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const [activeId, setActiveId] = useState<string | null>(null);

  const totalUnread = feeds.reduce((sum, f) => sum + f.unreadCount, 0);

  const navItems = [
    { id: "all", icon: Home, label: "All Articles", count: totalUnread },
    { id: "starred", icon: Star, label: "Starred", count: starredCount },
    { id: "recent", icon: Clock, label: "Recently Read", count: null },
    { id: "archive", icon: Archive, label: "Archive", count: null },
  ];

  const { data: session } = useSession();

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories((prev) =>
      prev.includes(categoryId)
        ? prev.filter((c) => c !== categoryId)
        : [...prev, categoryId],
    );
  };

  const filteredFeeds = useMemo(() => {
    if (!searchQuery) return null;
    return feeds.filter((f) =>
      f.name.toLowerCase().includes(searchQuery.toLowerCase()),
    );
  }, [feeds, searchQuery]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over || active.id === over.id) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    if (activeData?.type === "category" && overData?.type === "category") {
      const oldIndex = allCategories.findIndex((c: any) => c.id === active.id);
      const newIndex = allCategories.findIndex((c: any) => c.id === over.id);

      const newOrder = arrayMove(allCategories, oldIndex, newIndex);
      await updateCategoryOrder.mutateAsync(
        newOrder.map((c: any, i) => ({ id: c.id, order: i })),
      );
    } else if (activeData?.type === "feed" && overData?.type === "feed") {
      const activeFeed = feeds.find((f) => f.id === active.id);
      const overFeed = feeds.find((f) => f.id === over.id);

      if (activeFeed && overFeed) {
        const catFeeds = feeds.filter(
          (f) => f.category === activeFeed.category,
        );
        const oldIndex = catFeeds.findIndex((f) => f.id === active.id);
        const newIndex = catFeeds.findIndex((f) => f.id === over.id);

        const newOrder = arrayMove(catFeeds, oldIndex, newIndex);
        await updateFeedOrder.mutateAsync(
          newOrder.map((f, i) => ({
            id: f.id,
            order: i,
            categoryId:
              allCategories.find((c: any) => c.name === f.category)?.id || null,
          })),
        );
      }
    }
  };

  if (isCollapsed) {
    // Keep internal collapsed view as-is for now, maybe add tooltips
    return (
      <aside className="w-20 h-full bg-sidebar border-r border-sidebar-border flex flex-col items-center py-6 gap-3">
        <div className="mb-6 shadow-sm">
          <img
            src="/logo.svg"
            alt="Logo"
            className="w-10 h-10 invert dark:invert-0"
          />
        </div>
        {navItems.map((item) => (
          <Button
            key={item.id}
            variant="ghost"
            size="icon"
            className={cn(
              "w-12 h-12 rounded-xl relative transition-all duration-200",
              selectedFeed === null &&
                selectedCategory === (item.id === "all" ? "All" : item.label) &&
                "bg-sidebar-accent",
            )}
            onClick={() => {
              onSelectFeed(null);
              onSelectCategory(item.id === "all" ? "All" : item.label);
            }}
          >
            <item.icon className="w-5 h-5 text-sidebar-foreground" />
            {item.count !== null && item.count > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-accent text-accent-foreground text-xs flex items-center justify-center font-semibold shadow-sm">
                {item.count > 99 ? "99+" : item.count}
              </span>
            )}
          </Button>
        ))}
      </aside>
    );
  }

  return (
    <aside className="w-80 h-full bg-sidebar border-r border-sidebar-border flex flex-col">
      {/* Header */}
      <div className="p-5 border-b border-sidebar-border">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-4">
            <img
              src="/logo.svg"
              alt="FeedFerret Logo"
              className="w-12 h-12 invert dark:invert-0"
            />
            <div>
              <h1 className="text-xl font-bold text-sidebar-foreground tracking-tight">
                FeedFerret
              </h1>
              <p className="text-sm text-muted-foreground">
                {totalUnread} unread
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
            className="pl-11 h-12 text-base bg-sidebar-accent border-0 rounded-xl"
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Navigation */}
          <nav className="space-y-1.5 mb-8">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  onSelectFeed(null);
                  onSelectCategory(item.id === "all" ? "All" : item.label);
                }}
                className={cn(
                  "w-full flex items-center gap-4 px-4 py-3 rounded-xl text-base transition-all",
                  selectedFeed === null &&
                    (item.id === "all"
                      ? selectedCategory === "All"
                      : selectedCategory === item.label)
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
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

          {/* Feeds Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between px-4">
              <span className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                Feeds
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="w-8 h-8 rounded-lg"
                onClick={() => setIsAddFeedOpen(true)}
              >
                <Plus className="w-5 h-5" />
              </Button>
            </div>

            {isAddFeedOpen && (
              <div className="px-4 py-2 space-y-3 bg-muted/20 rounded-xl">
                <Input
                  placeholder="Feed URL..."
                  value={newFeedUrl}
                  onChange={(e) => setNewFeedUrl(e.target.value)}
                  className="h-10 text-sm bg-sidebar-accent border-0"
                />
                <Select
                  value={newFeedCategoryId}
                  onValueChange={setNewFeedCategoryId}
                >
                  <SelectTrigger className="h-10 text-sm bg-sidebar-accent border-0">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No Category</SelectItem>
                    {allCategories.map((cat: any) => (
                      <SelectItem key={cat.id} value={cat.id}>
                        {cat.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={!newFeedUrl || isAddingFeed}
                    onClick={async () => {
                      setIsAddingFeed(true);
                      await addNewFeed.mutateAsync({
                        url: newFeedUrl,
                        categoryId:
                          newFeedCategoryId === "none"
                            ? undefined
                            : newFeedCategoryId,
                      });
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
                    className="flex-1"
                    onClick={() => setIsAddFeedOpen(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {searchQuery ? (
              <div className="space-y-1">
                {filteredFeeds?.map((feed) => (
                  <SimpleFeedItem
                    key={feed.id}
                    feed={feed}
                    isSelected={selectedFeed === feed.id}
                    onSelect={() => onSelectFeed(feed.id)}
                  />
                ))}
                {filteredFeeds?.length === 0 && (
                  <p className="text-sm text-muted-foreground px-4">
                    No feeds found
                  </p>
                )}
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                modifiers={[restrictToVerticalAxis]}
              >
                <SortableContext
                  items={allCategories.map((c: any) => c.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1">
                    {allCategories.map((category: any) => (
                      <SortableCategory
                        key={category.id}
                        category={category}
                        feeds={feeds.filter(
                          (f) => f.categoryId === category.id,
                        )}
                        selectedFeed={selectedFeed}
                        onSelectFeed={onSelectFeed}
                        expanded={expandedCategories.includes(category.id)}
                        onToggle={() => toggleCategory(category.id)}
                      />
                    ))}

                    {/* Uncategorized Feeds */}
                    <UncategorizedGroup
                      feeds={feeds.filter((f) => !f.categoryId)}
                      selectedFeed={selectedFeed}
                      onSelectFeed={onSelectFeed}
                    />
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="p-4 border-t border-sidebar-border space-y-1">
        {session?.user && (
          <div className="flex items-center gap-3 px-3 py-2 bg-sidebar-accent/30 rounded-xl mb-2">
            <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
              <UserIcon className="w-4 h-4" />
            </div>
            <p className="flex-1 text-sm font-medium truncate">
              {session.user.name || session.user.email}
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="w-8 h-8"
              onClick={() => setIsSettingsOpen(true)}
            >
              <SettingsIcon className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="w-8 h-8 text-destructive"
              onClick={() => signOut()}
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        )}
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 h-11 rounded-xl"
          onClick={() => setIsManagementOpen(true)}
        >
          <Folder className="w-4 h-4" />
          Manage Feeds
        </Button>
        {session?.user?.role === "ADMIN" && (
          <Button
            variant="ghost"
            className="w-full justify-start gap-3 h-11 rounded-xl"
            onClick={() => setIsServerManagementOpen(true)}
          >
            <Users className="w-4 h-4" />
            Server Settings
          </Button>
        )}
      </div>

      <FeedManagement
        open={isManagementOpen}
        onOpenChange={setIsManagementOpen}
      />
      <ServerManagementDialog
        open={isServerManagementOpen}
        onOpenChange={setIsServerManagementOpen}
      />
      <SettingsDialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen} />
    </aside>
  );
}

function SortableCategory({
  category,
  feeds,
  selectedFeed,
  onSelectFeed,
  expanded,
  onToggle,
}: any) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: category.id,
    data: { type: "category" },
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="group">
      <div className="flex items-center gap-2 px-4 py-2 hover:bg-sidebar-accent/30 rounded-lg transition-colors">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing"
        >
          <Folder className="w-4 h-4 text-primary/70" />
        </button>
        <button
          onClick={onToggle}
          className="flex-1 flex items-center justify-between text-xs font-bold text-muted-foreground uppercase tracking-wider"
        >
          <span>{category.name}</span>
          <ChevronDown
            className={cn(
              "w-3.5 h-3.5 transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
      </div>

      {expanded && (
        <div className="ml-4 pl-2 border-l border-sidebar-border/50 py-1 space-y-0.5">
          <SortableContext
            items={feeds.map((f: any) => f.id)}
            strategy={verticalListSortingStrategy}
          >
            {feeds.map((feed: any) => (
              <SortableFeedItem
                key={feed.id}
                feed={feed}
                isSelected={selectedFeed === feed.id}
                onSelect={() => onSelectFeed(feed.id)}
              />
            ))}
          </SortableContext>
          {feeds.length === 0 && (
            <p className="text-[10px] text-muted-foreground/50 px-3 py-1 italic">
              No feeds
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SortableFeedItem({ feed, isSelected, onSelect }: any) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: feed.id,
    data: { type: "feed" },
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <SimpleFeedItem feed={feed} isSelected={isSelected} onSelect={onSelect} />
    </div>
  );
}

function SimpleFeedItem({ feed, isSelected, onSelect }: any) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-1.5 rounded-lg text-sm transition-all group",
        isSelected
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-sidebar-foreground",
      )}
    >
      <span className="text-lg shrink-0">{feed.icon || "📰"}</span>
      <span className="flex-1 text-left truncate font-medium">{feed.name}</span>
      {feed.unreadCount > 0 && (
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded-full font-bold tabular-nums",
            isSelected
              ? "bg-primary-foreground/20 text-primary-foreground"
              : "bg-muted text-muted-foreground",
          )}
        >
          {feed.unreadCount}
        </span>
      )}
    </button>
  );
}

function UncategorizedGroup({ feeds, selectedFeed, onSelectFeed }: any) {
  if (feeds.length === 0) return null;
  return (
    <div className="py-2">
      <div className="px-4 py-2">
        <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
          Uncategorized
        </h3>
      </div>
      <div className="ml-4 pl-2 py-1 space-y-0.5">
        {feeds.map((feed: any) => (
          <SimpleFeedItem
            key={feed.id}
            feed={feed}
            isSelected={selectedFeed === feed.id}
            onSelect={() => onSelectFeed(feed.id)}
          />
        ))}
      </div>
    </div>
  );
}
