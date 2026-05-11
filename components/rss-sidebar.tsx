"use client";

import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { FeedSource } from "@/lib/rss-data";
import Link from "next/link";
import {
  Home,
  Star,
  Clock,
  Archive,
  Plus,
  ChevronDown,
  Search,
  Inbox,
  LogOut,
  User as UserIcon,
  Folder,
  Users,
  GripVertical,
  Tag,
  Bookmark,
  MoreHorizontal,
  RefreshCw,
  CheckCheck,
  ExternalLink,
  Pencil,
  Activity,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSession, signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FeedManagement } from "./feed-management";
import {
  useAddFeed,
  useCategories,
  useUpdateFeedOrder,
  useUpdateCategoryOrder,
  useStarredCount,
  useReadLaterCount,
  useLabels,
  useSavedSearches,
  useRefreshFeed,
  useMarkAllAsRead,
} from "@/hooks/use-rss-data";
import { ServerManagementDialog } from "./server-management-dialog";
import { toast } from "sonner";
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
  closestCorners,
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
  const [managementInitialTab, setManagementInitialTab] = useState<
    "feeds" | "categories" | "labels" | "saved-searches" | "health" | "rules" | undefined
  >(undefined);
  const [isAddFeedOpen, setIsAddFeedOpen] = useState(false);
  const [newFeedUrl, setNewFeedUrl] = useState("");
  const [newFeedCategoryId, setNewFeedCategoryId] = useState<string>("none");
  const [isAddingFeed, setIsAddingFeed] = useState(false);
  const [isServerManagementOpen, setIsServerManagementOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const addNewFeed = useAddFeed();
  const { data: allCategories = [] } = useCategories();
  const updateFeedOrder = useUpdateFeedOrder();
  const updateCategoryOrder = useUpdateCategoryOrder();
  const { data: starredCount = 0 } = useStarredCount();
  const { data: readLaterCount = 0 } = useReadLaterCount();
  const { data: labels = [] } = useLabels();
  const { data: savedSearches = [] } = useSavedSearches();
  const refreshFeed = useRefreshFeed();
  const markAllRead = useMarkAllAsRead();

  const openFeedManagement = (tab?: typeof managementInitialTab) => {
    setManagementInitialTab(tab);
    setIsManagementOpen(true);
  };

  const renderFeedRow = (feed: any) => (
    <FeedRow
      key={feed.id}
      feed={feed}
      isSelected={selectedFeed === feed.id}
      onSelect={() => onSelectFeed(feed.id)}
      onRefresh={() => refreshFeed.mutate(feed.id)}
      onMarkRead={() => markAllRead.mutate({ feedId: feed.id })}
      onEdit={() => openFeedManagement("feeds")}
      onShowHealth={() => openFeedManagement("health")}
    />
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const [activeId, setActiveId] = useState<string | null>(null);

  const totalUnread = feeds.reduce((sum, f) => sum + f.unreadCount, 0);

  const navItems = [
    { id: "new", icon: Inbox, label: "New Articles", count: totalUnread },
    { id: "all", icon: Home, label: "All Articles", count: null },
    { id: "starred", icon: Star, label: "Starred", count: starredCount },
    { id: "readlater", icon: Bookmark, label: "Read Later", count: readLaterCount },
    { id: "recent", icon: Clock, label: "Recently Read", count: null },
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

    if (!over) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    // Handle Nesting (Active is dropped ON Over)
    if (active.id !== over.id) {
      if (activeData?.type === "category" && overData?.type === "category") {
        // Drop category on another category -> Nest
        // Check if we are dropping ON or ABOVE/BELOW (reordering)
        // For simplicity, we'll reorder if they are siblings, nest if dropped on a potential parent
        // But user specifically asked for "dropping it on that new overcategory"

        // If they are different levels or we want to force nesting:
        // For now, let's allow reordering and also handle "move" if parent changes
        const activeCategory = allCategories.find(
          (c: any) => c.id === active.id,
        );
        const overCategory = allCategories.find((c: any) => c.id === over.id);

        if (activeCategory && overCategory) {
          await updateCategoryOrder.mutateAsync([
            {
              id: active.id as string,
              order: 0,
              parentId: over.id as string,
            },
          ]);
          toast.success(
            `Moved ${activeCategory.name} into ${overCategory.name}`,
          );
          return;
        }
      } else if (activeData?.type === "feed" && overData?.type === "category") {
        // Drop feed on category -> Move to category
        await updateFeedOrder.mutateAsync([
          {
            id: active.id as string,
            order: 0,
            categoryId: over.id as string,
          },
        ]);
        return;
      }
    }

    if (!over || active.id === over.id) return;

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
          (f) => f.categoryId === activeFeed.categoryId,
        );
        const oldIndex = catFeeds.findIndex((f) => f.id === active.id);
        const newIndex = catFeeds.findIndex((f) => f.id === over.id);

        const newOrder = arrayMove(catFeeds, oldIndex, newIndex);
        await updateFeedOrder.mutateAsync(
          newOrder.map((f, i) => ({
            id: f.id,
            order: i,
            categoryId: activeFeed.categoryId,
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
              onSelectCategory(
                item.id === "all"
                  ? "All"
                  : item.id === "new"
                    ? "New Articles"
                    : item.label,
              );
            }}
          >
            <item.icon className="w-5 h-5 text-sidebar-foreground" />
            {item.count !== null && item.count > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-brand/90 text-white text-xs flex items-center justify-center font-semibold shadow-sm">
                {item.count > 99 ? "99+" : item.count}
              </span>
            )}
          </Button>
        ))}
      </aside>
    );
  }

  return (
    <aside className="h-full w-full lg:w-80 bg-sidebar/85 backdrop-blur-2xl border-r border-sidebar-border/70 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-5 border-b border-sidebar-border/70">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-4">
            <img
              src="/logo.svg"
              alt="FeedFerret Logo"
              className="w-12 h-12 invert dark:invert-0"
            />
            <div>
              <h1 className="text-xl font-semibold text-sidebar-foreground tracking-[-0.03em]">
                FeedFerret
              </h1>
              <p className="text-sm text-muted-foreground">
                {totalUnread} unread
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="w-8 h-8 rounded-xl shrink-0"
            onClick={() => setIsSearchOpen(true)}
          >
            <Search className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 overflow-hidden min-h-0">
        <div className="p-4">
          {/* Navigation */}
          <nav className="space-y-0.5 mb-6">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  onSelectFeed(null);
                  onSelectCategory(
                    item.id === "all"
                      ? "All"
                      : item.id === "new"
                        ? "New Articles"
                        : item.label,
                  );
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3.5 py-2 rounded-2xl text-sm transition-all",
                  selectedFeed === null &&
                    (item.id === "all"
                      ? selectedCategory === "All"
                      : item.id === "new"
                        ? selectedCategory === "New Articles"
                        : selectedCategory === item.label)
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold shadow-sm"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                )}
              >
                <item.icon className="w-5 h-5" />
                <span className="flex-1 text-left">{item.label}</span>
                {item.count !== null && item.count > 0 && (
                  <span className="text-xs tabular-nums text-muted-foreground bg-muted px-2 py-0.5 rounded-full font-medium">
                    {item.count}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {(savedSearches.length > 0 || labels.length > 0) && (
            <div className="mb-8 space-y-5">
              {savedSearches.length > 0 && (
                <div className="space-y-1">
                  <div className="px-4 pb-1">
                    <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Saved Searches
                    </span>
                  </div>
                  {savedSearches.map((item: any) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        onSelectFeed(null);
                        onSelectCategory(`Search:${item.id}`);
                      }}
                      className={cn(
                        "w-full flex items-center gap-3 px-3.5 py-2 rounded-2xl text-sm transition-all",
                        selectedFeed === null && selectedCategory === `Search:${item.id}`
                          ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold shadow-sm"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                      )}
                    >
                      <Bookmark className="h-4 w-4 text-muted-foreground" />
                      <span className="flex-1 truncate text-left">{item.name}</span>
                    </button>
                  ))}
                </div>
              )}

              {labels.length > 0 && (
                <div className="space-y-1">
                  <div className="px-4 pb-1">
                    <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Labels
                    </span>
                  </div>
                  {labels.map((item: any) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        onSelectFeed(null);
                        onSelectCategory(`Label:${item.id}`);
                      }}
                      className={cn(
                        "w-full flex items-center gap-3 px-3.5 py-2 rounded-2xl text-sm transition-all",
                        selectedFeed === null && selectedCategory === `Label:${item.id}`
                          ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold shadow-sm"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                      )}
                    >
                      <Tag className="h-4 w-4" style={{ color: item.color }} />
                      <span className="flex-1 truncate text-left">{item.name}</span>
                      {item._count?.articles > 0 && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                          {item._count.articles}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Feeds Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between px-4">
              <span className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                Feeds
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="w-8 h-8 rounded-xl"
                onClick={() => setIsAddFeedOpen(true)}
              >
                <Plus className="w-5 h-5" />
              </Button>
            </div>

            {isAddFeedOpen && (
              <div className="px-4 py-3 space-y-3 bg-muted/25 rounded-2xl border border-border/50">
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

            <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
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
                        renderFeedRow={renderFeedRow}
                      />
                    ))}

                    {/* Uncategorized Feeds */}
                    <UncategorizedGroup
                      feeds={feeds.filter((f) => !f.categoryId)}
                      renderFeedRow={renderFeedRow}
                    />
                  </div>
                </SortableContext>
              </DndContext>
          </div>
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="p-3 border-t border-sidebar-border/70">
        <TooltipProvider delayDuration={500}>
          <div className="flex items-center justify-around">
            {session?.user && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link href="/settings">
                    <Button variant="ghost" size="icon" className="w-9 h-9 rounded-xl">
                      <UserIcon className="w-4 h-4" />
                    </Button>
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {session.user.name || session.user.email}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-9 h-9 rounded-xl"
                  onClick={() => openFeedManagement(undefined)}
                >
                  <Folder className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Manage Feeds</TooltipContent>
            </Tooltip>
            {session?.user?.role === "ADMIN" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-9 h-9 rounded-xl"
                    onClick={() => setIsServerManagementOpen(true)}
                  >
                    <Users className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Server Settings</TooltipContent>
              </Tooltip>
            )}
            {session?.user && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-9 h-9 rounded-xl text-destructive hover:text-destructive"
                    onClick={() => signOut()}
                  >
                    <LogOut className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Sign out</TooltipContent>
              </Tooltip>
            )}
          </div>
        </TooltipProvider>
      </div>

      <Dialog open={isSearchOpen} onOpenChange={setIsSearchOpen}>
        <DialogContent className="max-w-md rounded-2xl p-0 overflow-hidden">
          <DialogHeader className="px-4 pt-4 pb-2">
            <DialogTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Search Feeds
            </DialogTitle>
          </DialogHeader>
          <div className="px-4 pb-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                autoFocus
                placeholder="Feed suchen..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-10 text-sm bg-muted border-0 rounded-xl"
              />
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto px-2 pb-3">
            {searchQuery ? (
              <>
                {filteredFeeds?.map((feed) => (
                  <button
                    key={feed.id}
                    onClick={() => {
                      onSelectFeed(feed.id);
                      setIsSearchOpen(false);
                      setSearchQuery("");
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm hover:bg-muted transition-colors"
                  >
                    <span className="text-base shrink-0">{feed.icon || "📰"}</span>
                    <span className="flex-1 text-left truncate">{feed.name}</span>
                    {feed.unreadCount > 0 && (
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-brand/15 text-brand font-medium tabular-nums">
                        {feed.unreadCount}
                      </span>
                    )}
                  </button>
                ))}
                {filteredFeeds?.length === 0 && (
                  <p className="text-sm text-muted-foreground px-3 py-4 text-center">
                    Keine Feeds gefunden
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground px-3 py-4 text-center">
                Suchbegriff eingeben…
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <FeedManagement
        open={isManagementOpen}
        onOpenChange={(open) => {
          setIsManagementOpen(open);
          if (!open) setManagementInitialTab(undefined);
        }}
        initialTab={managementInitialTab}
      />
      <ServerManagementDialog
        open={isServerManagementOpen}
        onOpenChange={setIsServerManagementOpen}
      />
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
  renderFeedRow,
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
    <div ref={setNodeRef} style={style} className="group w-full overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 hover:bg-sidebar-accent/30 rounded-lg transition-colors">
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing hover:bg-muted p-1 rounded transition-colors"
        >
          <GripVertical className="w-3.5 h-3.5 text-muted-foreground/50" />
        </div>
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
        <div className="ml-4 pl-2 border-l border-sidebar-border/50 py-1 space-y-0.5 overflow-hidden">
          <SortableContext
            items={feeds.map((f: any) => f.id)}
            strategy={verticalListSortingStrategy}
          >
            {feeds.map((feed: any) => (
              <SortableFeedItem
                key={feed.id}
                feed={feed}
                renderFeedRow={renderFeedRow}
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

function SortableFeedItem({ feed, renderFeedRow }: any) {
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
    <div
      ref={setNodeRef}
      style={style}
      className="group/feed w-full flex items-center min-w-0 overflow-hidden"
    >
      <div
        {...attributes}
        {...listeners}
        className="opacity-0 group-hover/feed:opacity-100 cursor-grab active:cursor-grabbing p-1 shrink-0"
      >
        <GripVertical className="w-3.5 h-3.5 text-muted-foreground/30" />
      </div>
      <div className="flex-1 min-w-0">{renderFeedRow(feed)}</div>
    </div>
  );
}

function SimpleFeedItem({ feed, isSelected, onSelect, hideUnreadBadge }: any) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-1.5 rounded-lg text-sm transition-all group min-w-0",
        isSelected
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-sidebar-foreground",
      )}
    >
      <span className="text-lg shrink-0">{feed.icon || "📰"}</span>
      <span className="flex-1 text-left truncate font-medium">{feed.name}</span>
      {!hideUnreadBadge && feed.unreadCount > 0 && (
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded-full font-bold tabular-nums",
            isSelected
              ? "bg-primary-foreground/20 text-primary-foreground"
              : "bg-brand/15 text-brand",
          )}
        >
          {feed.unreadCount}
        </span>
      )}
    </button>
  );
}

function FeedQuickActions({
  feed,
  onRefresh,
  onMarkRead,
  onEdit,
  onShowHealth,
}: {
  feed: any;
  onRefresh: () => void;
  onMarkRead: () => void;
  onEdit: () => void;
  onShowHealth: () => void;
}) {
  const websiteUrl = (() => {
    try {
      return new URL(feed.url).origin;
    } catch {
      return null;
    }
  })();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Feed actions"
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground/80 hover:text-foreground hover:bg-sidebar-accent/60 transition-colors"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-52 rounded-2xl p-2 shadow-2xl border-none bg-popover/95 backdrop-blur-xl"
      >
        <DropdownMenuItem
          className="rounded-xl py-2.5 px-3 text-sm"
          onClick={onRefresh}
        >
          <RefreshCw className="w-4 h-4 mr-3" />
          Refresh feed
        </DropdownMenuItem>
        <DropdownMenuItem
          className="rounded-xl py-2.5 px-3 text-sm"
          onClick={onMarkRead}
        >
          <CheckCheck className="w-4 h-4 mr-3" />
          Mark all as read
        </DropdownMenuItem>
        {websiteUrl && (
          <DropdownMenuItem
            className="rounded-xl py-2.5 px-3 text-sm"
            onClick={() => window.open(websiteUrl, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink className="w-4 h-4 mr-3" />
            Open website
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator className="my-1.5 bg-border/50" />
        <DropdownMenuItem
          className="rounded-xl py-2.5 px-3 text-sm"
          onClick={onEdit}
        >
          <Pencil className="w-4 h-4 mr-3" />
          Edit feed
        </DropdownMenuItem>
        <DropdownMenuItem
          className="rounded-xl py-2.5 px-3 text-sm"
          onClick={onShowHealth}
        >
          <Activity className="w-4 h-4 mr-3" />
          Feed health
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FeedRow({
  feed,
  isSelected,
  onSelect,
  onRefresh,
  onMarkRead,
  onEdit,
  onShowHealth,
}: {
  feed: any;
  isSelected: boolean;
  onSelect: () => void;
  onRefresh: () => void;
  onMarkRead: () => void;
  onEdit: () => void;
  onShowHealth: () => void;
}) {
  return (
    <div className="group/row relative w-full flex items-center gap-1 min-w-0 overflow-hidden">
      <div className="flex-1 min-w-0">
        <SimpleFeedItem feed={feed} isSelected={isSelected} onSelect={onSelect} />
      </div>
      <div className="opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 data-[state=open]:opacity-100 transition-opacity">
        <FeedQuickActions
          feed={feed}
          onRefresh={onRefresh}
          onMarkRead={onMarkRead}
          onEdit={onEdit}
          onShowHealth={onShowHealth}
        />
      </div>
    </div>
  );
}

function UncategorizedGroup({ feeds, renderFeedRow }: any) {
  if (feeds.length === 0) return null;
  return (
    <div className="py-2">
      <div className="px-4 py-2">
        <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
          Uncategorized
        </h3>
      </div>
      <div className="ml-4 pl-2 py-1 space-y-0.5">
        {feeds.map((feed: any) => renderFeedRow(feed))}
      </div>
    </div>
  );
}
