"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { FeedSource } from "@/lib/rss-data";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Home,
  Star,
  Plus,
  ChevronDown,
  Search,
  Bell,
  LogOut,
  Cog,
  GripVertical,
  Tag,
  Bookmark,
  MoreHorizontal,
  RefreshCw,
  CheckCheck,
  ExternalLink,
  Pencil,
  Activity,
  Compass,
  Download,
  Rss,
  Trash2,
  AlertCircle,
  Play,
  Mail,
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DiscoveryPanel } from "@/components/discovery-panel";
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
import {
  useAddFeed,
  useCategories,
  useUpdateFeedOrder,
  useUpdateCategoryOrder,
  useStarredCount,
  useSpoilerCount,
  useReadLaterCount,
  useLabels,
  useSavedSearches,
  useRefreshFeed,
  useMarkAllAsRead,
  useDeleteFeed,
  useImportOpml,
  useNotifications,
  useUnreadNotificationCount,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
} from "@/hooks/use-rss-data";
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
import { DEFAULT_STARTER_PACKS, starterPackToOpml, type StarterPack } from "@/lib/starter-packs";
import { SpoilerIcon } from "@/components/icons/spoiler-icon";

interface RssSidebarProps {
  feeds: FeedSource[];
  selectedFeed: string | null;
  selectedCategory: string;
  onSelectFeed: (feedId: string | null) => void;
  onSelectCategory: (category: string) => void;
  isCollapsed?: boolean;
  defaultOpenAddFeed?: boolean;
}

export function RssSidebar({
  feeds,
  selectedFeed,
  selectedCategory,
  onSelectFeed,
  onSelectCategory,
  isCollapsed = false,
  defaultOpenAddFeed = false,
}: RssSidebarProps) {
  const router = useRouter();
  const [expandedCategories, setExpandedCategories] = useState<string[]>([]);
  const [isAddFeedOpen, setIsAddFeedOpen] = useState(false);
  const [newFeedUrl, setNewFeedUrl] = useState("");
  const [newFeedCategoryId, setNewFeedCategoryId] = useState<string>("none");
  const [isAddingFeed, setIsAddingFeed] = useState(false);
  const [discoveredFeeds, setDiscoveredFeeds] = useState<{ url: string; title: string; type: string }[]>([]);
  const [discoveryMessage, setDiscoveryMessage] = useState<string | null>(null);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [importingPack, setImportingPack] = useState<string | null>(null);
  const [starterPacks, setStarterPacks] = useState<StarterPack[]>(DEFAULT_STARTER_PACKS);
  const [addingFeedUrl, setAddingFeedUrl] = useState<string | null>(null);
  const [addFeedTab, setAddFeedTab] = useState<"url" | "discover">("url");
  const [branding, setBranding] = useState<{ instanceName: string; instanceIconDataUrl: string | null }>({
    instanceName: "FeedFerret",
    instanceIconDataUrl: null,
  });

  const addNewFeed = useAddFeed();
  const deleteFeedMutation = useDeleteFeed();
  const importOpml = useImportOpml();
  const { data: allCategories = [] } = useCategories();
  const updateFeedOrder = useUpdateFeedOrder();
  const updateCategoryOrder = useUpdateCategoryOrder();
  const { data: starredCount = 0 } = useStarredCount();
  const { data: readLaterCount = 0 } = useReadLaterCount();
  const { data: spoilerCount = 0 } = useSpoilerCount();
  const { data: labels = [] } = useLabels();
  const { data: savedSearches = [] } = useSavedSearches();
  const refreshFeed = useRefreshFeed();
  const markAllRead = useMarkAllAsRead();
  const { data: notifications = [] } = useNotifications();
  const { data: unreadNotifications = 0 } = useUnreadNotificationCount();
  const markNotificationRead = useMarkNotificationRead();
  const markAllNotificationsRead = useMarkAllNotificationsRead();

  useEffect(() => {
    if (defaultOpenAddFeed) setIsAddFeedOpen(true);
  }, [defaultOpenAddFeed]);

  const loadStarterPacks = () => {
    fetch("/api/starter-packs")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data?.packs)) setStarterPacks(data.packs);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetch("/api/instance")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setBranding({
          instanceName: data.instanceName || "FeedFerret",
          instanceIconDataUrl: data.instanceIconDataUrl || null,
        });
      })
      .catch(() => {});

    loadStarterPacks();
  }, []);

  const handleDiscover = async () => {
    if (!newFeedUrl) return;
    setIsDiscovering(true);
    setDiscoveredFeeds([]);
    setDiscoveryMessage(null);
    try {
      const params = new URLSearchParams({ url: newFeedUrl });
      const res = await fetch(`/api/discover?${params}`);
      const data = await res.json();
      const feeds = data.feeds || [];
      setDiscoveredFeeds(feeds);
      if (feeds.length === 0) {
        const message = "No RSS/Atom feed found at that site.";
        setDiscoveryMessage(message);
        toast.info(message);
      }
    } catch {
      setDiscoveryMessage("Discovery failed. Try pasting a direct RSS/Atom feed URL.");
      toast.error("Discovery failed — try a direct RSS/Atom URL");
    } finally {
      setIsDiscovering(false);
    }
  };

  const handleAddFeed = async (url: string, title?: string) => {
    setIsAddingFeed(true);
    setAddingFeedUrl(url);
    try {
      const result = await addNewFeed.mutateAsync({
        url,
        categoryId: newFeedCategoryId === "none" ? undefined : newFeedCategoryId,
      });
      if (!result?.success) {
        toast.error(result?.error || "Could not add feed");
        return;
      }
      toast.success(`Added ${result.feed?.name || title || "feed"}`);
      if (addFeedTab === "discover") {
        return;
      }
      setNewFeedUrl("");
      setDiscoveredFeeds([]);
      setDiscoveryMessage(null);
      setIsAddFeedOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add feed");
    } finally {
      setIsAddingFeed(false);
      setAddingFeedUrl(null);
    }
  };

  const handleImportStarterPack = async (pack: StarterPack) => {
    if (pack.feeds.length === 0 && !pack.path) {
      toast.error(`${pack.name} has no feeds to import`);
      return;
    }
    setImportingPack(pack.id);
    try {
      let xml = "";
      if (pack.path && pack.feeds.length === 0) {
        const res = await fetch(`/starter-opml/${pack.path}`);
        if (!res.ok) throw new Error("Failed to fetch pack");
        xml = await res.text();
      } else {
        xml = starterPackToOpml(pack);
      }
      const result = await importOpml.mutateAsync(xml);
      const details = [
        result.feedsAdded ? `${result.feedsAdded} added` : null,
        result.feedsUpdated ? `${result.feedsUpdated} updated` : null,
      ].filter(Boolean).join(", ");
      if (!result.feedsAdded && !result.feedsUpdated) {
        toast.info(`${pack.name} did not contain new feeds`);
      } else {
        toast.success(`Imported ${pack.name}${details ? `: ${details}` : ""}`);
      }
      setIsAddFeedOpen(false);
    } catch (err) {
      toast.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImportingPack(null);
    }
  };

  const renderFeedRow = (feed: any) => (
    <FeedRow
      key={feed.id}
      feed={feed}
      isSelected={selectedFeed === feed.id}
      onSelect={() => onSelectFeed(feed.id)}
      onRefresh={() => refreshFeed.mutate(feed.id)}
      onMarkRead={() => markAllRead.mutate({ feedId: feed.id })}
      onEdit={() => router.push(`/manage-feeds?feedId=${feed.id}`)}
      onShowHealth={() => router.push("/manage-feeds?tab=health")}
      onDelete={() => setFeedToDelete({ id: feed.id, name: feed.name })}
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

  const [feedToDelete, setFeedToDelete] = useState<{ id: string; name: string } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const totalUnread = feeds.reduce((sum, f) => sum + f.unreadCount, 0);

  const navItems = [
    { id: "all", icon: Home, label: "All Articles", count: totalUnread },
    ...(starredCount > 0 ? [{ id: "starred", icon: Star, label: "Starred", count: starredCount }] : []),
    ...(readLaterCount > 0 ? [{ id: "readlater", icon: Bookmark, label: "Read Later", count: readLaterCount }] : []),
    ...(spoilerCount > 0
      ? [{ id: "spoiler", icon: SpoilerIcon as any, label: "Spoiler", count: spoilerCount }]
      : []),
  ];

  const { data: session } = useSession();

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories((prev) =>
      prev.includes(categoryId)
        ? prev.filter((c) => c !== categoryId)
        : [...prev, categoryId],
    );
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    // Handle feed dropped onto a category -> Move to category
    if (active.id !== over.id) {
      if (activeData?.type === "feed" && overData?.type === "category") {
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
          <Image
            src="/logo.svg"
            alt="Logo"
            width={40}
            height={40}
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
                item.id === "all" ? "All" : item.label,
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
    <>
    <aside role="navigation" aria-label="Feed navigation" className="h-full w-full lg:w-80 bg-sidebar/85 backdrop-blur-2xl border-r border-sidebar-border/70 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-5 border-b border-sidebar-border/70">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-4">
            {branding.instanceIconDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={branding.instanceIconDataUrl}
                alt={`${branding.instanceName} logo`}
                className="h-12 w-12 rounded-2xl object-cover"
              />
            ) : (
              <Image
                src="/logo.svg"
                alt="FeedFerret Logo"
                width={48}
                height={48}
                className="w-12 h-12 invert dark:invert-0"
              />
            )}
            <div>
              <h1 className="text-xl font-semibold text-sidebar-foreground tracking-[-0.03em]">
                {branding.instanceName}
              </h1>
              <p
                className="text-sm text-muted-foreground"
                aria-live="polite"
                aria-label={`${totalUnread} unread articles`}
              >
                {totalUnread} unread
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="w-8 h-8 rounded-xl shrink-0"
            onClick={() => window.dispatchEvent(new Event('focus-search'))}
            aria-label="Search articles"
          >
            <Search className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 overflow-hidden min-h-0">
        <div className="p-4 w-full min-w-0 max-w-full">
          {/* Navigation */}
          <nav className="space-y-0.5 mb-6">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  onSelectFeed(null);
                  onSelectCategory(
                    item.id === "all" ? "All" : item.label,
                  );
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3.5 py-2 rounded-2xl text-sm transition-all",
                  selectedFeed === null &&
                    (item.id === "all"
                      ? selectedCategory === "All"
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
                        selectedFeed === null &&
                          selectedCategory === `Search:${item.id}`
                          ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold shadow-sm"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                      )}
                    >
                      <Bookmark className="h-4 w-4 text-muted-foreground" />
                      <span className="flex-1 truncate text-left">
                        {item.name}
                      </span>
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
                        selectedFeed === null &&
                          selectedCategory === `Label:${item.id}`
                          ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold shadow-sm"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                      )}
                    >
                      <Tag className="h-4 w-4" style={{ color: item.color }} />
                      <span className="flex-1 truncate text-left">
                        {item.name}
                      </span>
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
                aria-label="Add feed"
              >
                <Plus className="w-5 h-5" />
              </Button>
            </div>


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
                      feeds={feeds.filter((f) => f.categoryId === category.id)}
                      selectedFeed={selectedFeed}
                      onSelectFeed={onSelectFeed}
                      expanded={expandedCategories.includes(category.id)}
                      onToggle={() => toggleCategory(category.id)}
                      renderFeedRow={renderFeedRow}
                      onSelectCategory={onSelectCategory}
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
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 rounded-xl sm:h-9 sm:w-9"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
                        <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5">
                          <path d="M14.5 7.5a5 5 0 1 0-10 0a5 5 0 0 0 10 0" />
                          <path d="M2.5 19.5a7 7 0 0 1 10-6.326M18 20c.93 0 1.74-.507 2.171-1.26M18 20c-.93 0-1.74-.507-2.171-1.26M18 20v1.5m0-6.5c.93 0 1.74.507 2.17 1.26M18 15c-.93 0-1.74.507-2.17 1.26M18 15v-1.5m3.5 2l-1.33.76M14.5 19.5l1.329-.76m5.671.76l-1.329-.76M14.5 15.5l1.33.76m4.34 0c.21.365.33.788.33 1.24s-.12.875-.329 1.24m-4.342 0a2.5 2.5 0 0 1-.329-1.24c0-.451.12-.875.33-1.24" />
                        </g>
                      </svg>
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
                <Link href="/manage-feeds">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 rounded-xl sm:h-9 sm:w-9"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="currentColor" d="M4 4c-1.11 0-2 .89-2 2v12a2 2 0 0 0 2 2h8.08a7 7 0 0 1-.08-1a7 7 0 0 1 7-7a7 7 0 0 1 3 .69V8a2 2 0 0 0-2-2h-8l-2-2zm14 10a.26.26 0 0 0-.26.21l-.19 1.32c-.3.13-.59.29-.85.47l-1.24-.5c-.11 0-.24 0-.31.13l-1 1.73c-.06.11-.04.24.06.32l1.06.82a4.2 4.2 0 0 0 0 1l-1.06.82a.26.26 0 0 0-.06.32l1 1.73c.06.13.19.13.31.13l1.24-.5c.26.18.54.35.85.47l.19 1.32c.02.12.12.21.26.21h2c.11 0 .22-.09.24-.21l.19-1.32c.3-.13.57-.29.84-.47l1.23.5c.13 0 .26 0 .33-.13l1-1.73a.26.26 0 0 0-.06-.32l-1.07-.82c.02-.17.04-.33.04-.5s-.01-.33-.04-.5l1.06-.82a.26.26 0 0 0 .06-.32l-1-1.73c-.06-.13-.19-.13-.32-.13l-1.23.5c-.27-.18-.54-.35-.85-.47l-.19-1.32A.236.236 0 0 0 20 14zm1 3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5c-.84 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5" />
                    </svg>
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="top">Manage Feeds</TooltipContent>
            </Tooltip>
            {session?.user?.role === "ADMIN" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link href="/server-settings">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 rounded-xl sm:h-9 sm:w-9"
                    >
                      <Cog className="w-4 h-4" />
                    </Button>
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="top">Server Settings</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-11 w-11 rounded-xl sm:h-9 sm:w-9 relative",
                        unreadNotifications ? "text-accent bg-accent/10" : "",
                      )}
                    >
                      <Bell className="w-4 h-4" />
                      {unreadNotifications > 0 && (
                        <span className="absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-background bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground shadow-sm">
                          {unreadNotifications > 9 ? "9+" : unreadNotifications}
                        </span>
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" side="top" className="w-80 rounded-2xl border-border/70 p-2">
                    <div className="flex items-center justify-between px-2 py-1.5">
                      <p className="text-sm font-semibold">Notifications</p>
                      {unreadNotifications > 0 && (
                        <button
                          className="hidden sm:inline text-xs text-primary hover:underline"
                          onClick={() => markAllNotificationsRead.mutate()}
                        >
                          Mark all read
                        </button>
                      )}
                    </div>
                    <DropdownMenuSeparator />
                    {notifications.length === 0 ? (
                      <div className="px-2 py-8 text-center">
                        <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                          <Bell className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <p className="text-sm font-medium text-foreground">No notifications</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">Set up keyword alerts to get notified when topics you care about appear.</p>
                      </div>
                    ) : (
                      (notifications as any[]).slice(0, 8).map((notification: any) => {
                        const typeIcon = notification.type === "feed_error"
                          ? <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                          : notification.type === "rule_match"
                          ? <Play className="h-3.5 w-3.5 text-muted-foreground" />
                          : notification.type === "digest_sent"
                          ? <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                          : <Bell className="h-3.5 w-3.5 text-accent" />;
                        return (
                          <DropdownMenuItem
                            key={notification.id}
                            className="items-start gap-3 rounded-xl px-2 py-2"
                            onClick={() => {
                              if (!notification.isRead) markNotificationRead.mutate(notification.id);
                              if (notification.articleId) {
                                window.location.href = `/?article=${encodeURIComponent(notification.articleId)}`;
                              }
                            }}
                          >
                            <span className="mt-0.5 shrink-0 flex items-center gap-1.5">
                              <span
                                className={cn(
                                  "h-1.5 w-1.5 rounded-full shrink-0",
                                  notification.isRead ? "bg-muted" : "bg-accent",
                                )}
                              />
                              {typeIcon}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{notification.title}</span>
                              <span className="line-clamp-2 text-xs text-muted-foreground">
                                {notification.body}
                              </span>
                            </span>
                          </DropdownMenuItem>
                        );
                      })
                    )}
                    {unreadNotifications > 0 && (
                      <>
                        <DropdownMenuSeparator className="sm:hidden" />
                        <button
                          type="button"
                          className="sm:hidden mt-1 w-full rounded-xl bg-primary/10 px-3 py-3 text-sm font-semibold text-primary active:scale-[0.98] transition-transform"
                          onClick={() => markAllNotificationsRead.mutate()}
                        >
                          Mark all as read
                        </button>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TooltipTrigger>
              <TooltipContent side="top">Notifications</TooltipContent>
            </Tooltip>
            {session?.user && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 rounded-xl sm:h-9 sm:w-9"
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

      <Dialog open={isAddFeedOpen} onOpenChange={(open) => {
        setIsAddFeedOpen(open);
        if (!open) {
          setDiscoveredFeeds([]);
          setDiscoveryMessage(null);
          setAddFeedTab("url");
        }
      }}>
        <DialogContent
          className="rounded-2xl"
          style={{ width: "calc(100vw - 1rem)", maxWidth: "28rem" }}
        >
          <DialogHeader>
            <DialogTitle>Add Feed</DialogTitle>
          </DialogHeader>
          <Tabs value={addFeedTab} onValueChange={(v) => setAddFeedTab(v as "url" | "discover")} className="w-full min-w-0">
            <TabsList className="grid w-full grid-cols-2 h-9 rounded-xl">
              <TabsTrigger value="url" className="text-xs rounded-lg">By URL</TabsTrigger>
              <TabsTrigger value="discover" className="text-xs rounded-lg">Discover</TabsTrigger>
            </TabsList>

            {/* URL Tab */}
            <TabsContent value="url" className="mt-3 space-y-3">
              <div className="flex gap-1.5">
                <Input
                  placeholder="Feed or site URL..."
                  value={newFeedUrl}
                  onChange={(e) => {
                    setNewFeedUrl(e.target.value);
                    setDiscoveredFeeds([]);
                    setDiscoveryMessage(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newFeedUrl) handleDiscover();
                  }}
                  className="h-9 text-sm flex-1"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 px-2 shrink-0"
                  disabled={!newFeedUrl || isDiscovering}
                  onClick={handleDiscover}
                  title="Find feeds at this URL"
                >
                  <Compass className={`w-4 h-4 ${isDiscovering ? "animate-spin" : ""}`} />
                </Button>
              </div>

              {discoveredFeeds.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground font-medium px-0.5">Found feeds</p>
                  {discoveredFeeds.map((f) => (
                    <div key={f.url} className="flex items-center gap-1.5 rounded-xl bg-muted px-2 py-1.5">
                      <Rss className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs truncate flex-1 text-foreground" title={f.url}>{f.title}</span>
                      <Button
                        size="sm"
                        className="h-6 px-2 text-xs shrink-0"
                        onClick={() => handleAddFeed(f.url, f.title)}
                        disabled={isAddingFeed}
                      >
                        Add
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {discoveryMessage && discoveredFeeds.length === 0 && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  {discoveryMessage}
                </div>
              )}

              <Select
                value={newFeedCategoryId}
                onValueChange={setNewFeedCategoryId}
              >
                <SelectTrigger className="h-9 text-sm">
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
                  onClick={() => handleAddFeed(newFeedUrl)}
                >
                  Add direct URL
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="flex-1"
                  onClick={() => {
                    setIsAddFeedOpen(false);
                    setDiscoveredFeeds([]);
                    setDiscoveryMessage(null);
                  }}
                >
                  Cancel
                </Button>
              </div>

              {/* Starter packs */}
              <div className="pt-1 border-t border-border/40">
                <p className="text-xs text-muted-foreground font-medium mb-1.5">Starter packs</p>
                <div className="space-y-1">
                  {starterPacks.map((pack) => (
                    <div key={pack.id} className="flex items-center gap-1.5 rounded-xl bg-muted px-2 py-1.5">
                      <span className="text-xs flex-1 text-foreground">
                        {pack.name}
                        <span className="text-muted-foreground ml-1">({pack.feeds.length || "OPML"})</span>
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs shrink-0"
                        disabled={importingPack === pack.id || (pack.feeds.length === 0 && !pack.path)}
                        onClick={() => handleImportStarterPack(pack)}
                      >
                        <Download className={cn("w-3 h-3 mr-1", importingPack === pack.id && "animate-bounce")} />
                        {importingPack === pack.id ? "Importing" : "Import"}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>

            {/* Discover Tab */}
            <TabsContent value="discover" className="mt-3 min-w-0 overflow-hidden">
              <div className="mb-3">
                <Select
                  value={newFeedCategoryId}
                  onValueChange={setNewFeedCategoryId}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Add to category..." />
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
              </div>
              <DiscoveryPanel
                onAddFeed={handleAddFeed}
                isAddingFeed={isAddingFeed}
                addingUrl={addingFeedUrl}
                subscribedUrls={new Set(feeds.map((f: any) => f.url).filter(Boolean))}
              />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

    </aside>

    <AlertDialog open={!!feedToDelete} onOpenChange={(open) => !open && setFeedToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &ldquo;{feedToDelete?.name}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete the feed and all its articles. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              if (!feedToDelete) return;
              deleteFeedMutation.mutate(feedToDelete.id, {
                onSuccess: () => toast.success(`Deleted ${feedToDelete.name}`),
                onError: () => toast.error("Could not delete feed. Try again."),
              });
              setFeedToDelete(null);
            }}
          >
            Delete feed
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
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
  onSelectCategory,
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
    <div
      ref={setNodeRef}
      style={style}
      className="group w-full overflow-hidden"
    >
      <div className="flex items-center gap-2 px-4 py-2 hover:bg-sidebar-accent/30 rounded-lg transition-colors">
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing hover:bg-muted p-1 rounded transition-colors"
        >
          <GripVertical className="w-3.5 h-3.5 text-muted-foreground/50" />
        </div>
        <button
          onClick={() => onSelectCategory?.(category.name)}
          className="flex-1 flex items-center text-xs font-bold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
        >
          <span>{category.name}</span>
        </button>
        <button
          onClick={onToggle}
          className="p-1 rounded hover:bg-muted transition-colors"
        >
          <ChevronDown
            className={cn(
              "w-3.5 h-3.5 transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
      </div>

      {expanded && (
        <div className="pl-4 pr-2 border-l border-sidebar-border/50 py-1 space-y-0.5 overflow-hidden">
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
        className="shrink-0 cursor-grab p-1 opacity-100 active:cursor-grabbing sm:opacity-0 sm:group-hover/feed:opacity-100"
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
      <div className="w-5 h-5 shrink-0 rounded-sm overflow-hidden bg-muted flex items-center justify-center">
        {feed.url ? (() => {
          try {
            const hostname = new URL(feed.url).hostname;
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`https://www.google.com/s2/favicons?domain=${hostname}&sz=32`}
                alt=""
                className="w-5 h-5"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            );
          } catch {
            return <span className="text-xs">{feed.icon || "📰"}</span>;
          }
        })() : (
          <span className="text-xs">{feed.icon || "📰"}</span>
        )}
      </div>
      <span className="flex-1 text-left truncate font-medium">{feed.name}</span>
      {feed.lastStatus === "error" && (
        <span title={feed.lastError || "Last sync failed"}>
          <AlertCircle className={cn("h-3.5 w-3.5 shrink-0 text-destructive", isSelected && "text-primary-foreground/70")} />
        </span>
      )}
      {!hideUnreadBadge && feed.unreadCount > 0 && (
        <span
          className={cn(
            "shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-bold tabular-nums",
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
  onDelete,
}: {
  feed: any;
  onRefresh: () => void;
  onMarkRead: () => void;
  onEdit: () => void;
  onShowHealth: () => void;
  onDelete: () => void;
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
            onClick={() =>
              window.open(websiteUrl, "_blank", "noopener,noreferrer")
            }
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
        <DropdownMenuSeparator className="my-1.5 bg-border/50" />
        <DropdownMenuItem
          className="rounded-xl py-2.5 px-3 text-sm text-destructive focus:text-destructive focus:bg-destructive/10"
          onClick={onDelete}
        >
          <Trash2 className="w-4 h-4 mr-3" />
          Delete feed
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
  onDelete,
}: {
  feed: any;
  isSelected: boolean;
  onSelect: () => void;
  onRefresh: () => void;
  onMarkRead: () => void;
  onEdit: () => void;
  onShowHealth: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group/row relative w-full flex items-center gap-1 min-w-0 overflow-hidden">
      <div className="flex-1 min-w-0">
        <SimpleFeedItem
          feed={feed}
          isSelected={isSelected}
          onSelect={onSelect}
        />
      </div>
      <div className="opacity-100 transition-opacity sm:opacity-0 sm:group-hover/row:opacity-100 sm:focus-within:opacity-100 data-[state=open]:opacity-100">
        <FeedQuickActions
          feed={feed}
          onRefresh={onRefresh}
          onMarkRead={onMarkRead}
          onEdit={onEdit}
          onShowHealth={onShowHealth}
          onDelete={onDelete}
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
      <div className="pl-4 pr-2 py-1 space-y-0.5">
        {feeds.map((feed: any) => renderFeedRow(feed))}
      </div>
    </div>
  );
}
