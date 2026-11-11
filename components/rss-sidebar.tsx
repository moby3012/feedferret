"use client";

import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";
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
  Rss,
  Trash2,
  AlertCircle,
  Play,
  Mail,
  BellOff,
  X,
  MailX,
  Ban,
} from "lucide-react";
import { NewsletterIcon } from "@/components/list/feed-favicon";
import { useNewsletterDialogs, useNewsletterFeedActions } from "@/components/newsletter/newsletter-actions";
import { isNewsletterFeed } from "@/lib/newsletter-constants";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { ResponsiveMenu, type OverlayMenuItem } from "@/components/ui/responsive-overlay";
import { getLayoutClass, isCoarsePointer } from "@/features/reader/layout/layout-class";
import { nav } from "@/features/reader/nav/store";
import { useOwnedOverlay } from "@/features/reader/nav/use-owned-overlay";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSession } from "next-auth/react";
import { useSignOut } from "@/components/shell/use-sign-out";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { categoryKey } from "@/features/reader/nav/sidebar-keys";
import {
  useCategories,
  useUpdateFeedOrder,
  useUpdateCategoryOrder,
  useStarredCount,
  useSpoilerCount,
  useReadLaterCount,
  useLabels,
  useSavedSearches,
  useRefreshFeed,
  useMarkViewRead,
  useDeleteFeed,
  useNotifications,
  useUnreadNotificationCount,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  useDismissNotification,
  useClearAllNotifications,
} from "@/hooks/use-rss-data";
import { toast } from "sonner";
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
import { SpoilerIcon } from "@/components/icons/spoiler-icon";
import { UnreadCount } from "@/components/ui/unread-count";
import { showsCount, type CountDisplay } from "@/lib/count-display";
import { isDeletableEmptyCategory } from "@/lib/empty-category";
import { DeleteEmptyCategoryDialog } from "@/components/delete-empty-category-dialog";

/** Where unread numbers show (`User.countDisplay`); read by the nested rows. */
const CountDisplayContext = createContext<CountDisplay>("all");


interface RssSidebarProps {
  feeds: FeedSource[];
  selectedFeed: string | null;
  selectedCategory: string;
  onSelectFeed: (feedId: string | null) => void;
  onSelectCategory: (category: string) => void;
  isCollapsed?: boolean;
  hideEmptyFeeds?: boolean;
  hideEmptyLabels?: boolean;
  /** Where unread numbers show (spec §4.9.3). */
  countDisplay?: CountDisplay;
  /** Opens the Add Feed dialog (a shell overlay, see components/add-feed-dialog.tsx). */
  onAddFeed: () => void;
  /** Opens an article in the shell (notification items); falls back to a full navigation. */
  onOpenArticle?: (articleId: string) => void;
  /** Extra control in the header row (the shell's collapse-to-rail button). */
  headerAction?: ReactNode;
}

export function RssSidebar({
  feeds,
  selectedFeed,
  selectedCategory,
  onSelectFeed,
  onSelectCategory,
  isCollapsed = false,
  hideEmptyFeeds = false,
  hideEmptyLabels = false,
  countDisplay = "all",
  onAddFeed,
  onOpenArticle,
  headerAction,
}: RssSidebarProps) {
  const t = useTranslations();
  const router = useRouter();
  const [expandedCategories, setExpandedCategories] = useState<string[]>([]);
  const [branding, setBranding] = useState<{ instanceName: string; instanceIconDataUrl: string | null }>({
    instanceName: "FeedFerret",
    instanceIconDataUrl: null,
  });

  const deleteFeedMutation = useDeleteFeed();
  const { data: allCategories = [] } = useCategories();
  const updateFeedOrder = useUpdateFeedOrder();
  const updateCategoryOrder = useUpdateCategoryOrder();
  const { data: starredCount = 0 } = useStarredCount();
  const { data: readLaterCount = 0 } = useReadLaterCount();
  const { data: spoilerCount = 0 } = useSpoilerCount();
  const { data: labels = [] } = useLabels();
  const { data: savedSearches = [] } = useSavedSearches();
  const refreshFeed = useRefreshFeed();
  // Same handler (and Undo toast) as the header / end-of-list card / shortcuts.
  const { markViewRead } = useMarkViewRead();
  const { data: notifications = [] } = useNotifications();
  const { data: unreadNotifications = 0 } = useUnreadNotificationCount();
  const markNotificationRead = useMarkNotificationRead();
  const markAllNotificationsRead = useMarkAllNotificationsRead();
  const dismissNotification = useDismissNotification();
  const clearAllNotifications = useClearAllNotifications();
  const [clearNotificationsOpen, setClearNotificationsOpen] = useState(false);



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

  }, []);

  const renderFeedRow = (feed: any) => (
    <FeedRow
      key={feed.id}
      feed={feed}
      isSelected={selectedFeed === feed.id}
      onSelect={() => onSelectFeed(feed.id)}
      onRefresh={() => refreshFeed.mutate(feed.id)}
      // The confirm mounts once the menu is gone (a vaul sheet unmounting under it would leave <body> inert).
      onMarkRead={() => window.requestAnimationFrame(() => window.setTimeout(() => setMarkAllFeed({ id: feed.id, name: feed.name, unread: feed.unreadCount ?? 0 }), 0))}
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
  // Inline "Delete category" of an empty category's "No feeds" line.
  const [categoryToDelete, setCategoryToDelete] = useState<{ id: string; name: string } | null>(null);
  // "Mark all as read" of a feed always asks first (owner decision 2026-11-10; same as the compact Feeds screen).
  const [markAllFeed, setMarkAllFeed] = useState<{ id: string; name: string; unread: number } | null>(null);
  const signOut = useSignOut();
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);
  // Bell menu: a nav overlay (system Back closes it, not the Feeds screen).
  const [notificationsOpen, setNotificationsOpen] = useOwnedOverlay("notifications");
  const [activeId, setActiveId] = useState<string | null>(null);

  const visibleFeeds = hideEmptyFeeds ? feeds.filter((f) => f.unreadCount > 0) : feeds;
  const visibleLabels = hideEmptyLabels ? labels.filter((l: any) => (l._count?.articles ?? 0) > 0) : labels;
  const totalUnread = feeds
    .filter((f) => !f.hideFromAllFeeds && !f.categoryHideFromAllFeeds)
    .reduce((sum, f) => sum + f.unreadCount, 0);

  const navItems = [
    { id: "all", icon: Home, label: t("sidebar.allArticles"), categoryId: "All", count: totalUnread },
    ...(starredCount > 0 ? [{ id: "starred", icon: Star, label: t("sidebar.starred"), categoryId: "Starred", count: starredCount }] : []),
    ...(readLaterCount > 0 ? [{ id: "readlater", icon: Bookmark, label: t("sidebar.readLater"), categoryId: "Read Later", count: readLaterCount }] : []),
    ...(spoilerCount > 0
      ? [{ id: "spoiler", icon: SpoilerIcon as any, label: t("sidebar.spoiler"), categoryId: "Spoiler", count: spoilerCount }]
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
      <aside className="w-20 h-full bg-sidebar border-e border-sidebar-border flex flex-col items-center py-6 gap-3">
        <div className="mb-6">
          <Image
            src="/logo.svg"
            alt="Logo"
            width={40}
            height={40}
            className="w-10 h-10 invert dark:invert-0"
          />
        </div>
        {navItems.map((item) => {
          const isActiveNav = selectedFeed === null && selectedCategory === item.categoryId;
          return (
          <Button
            key={item.id}
            variant="ghost"
            size="icon"
            className={cn(
              "w-12 h-12 rounded-panel relative transition-all duration-(--dur-base)",
              isActiveNav && "bg-sidebar-accent ring-2 ring-sidebar-ring/50",
            )}
            onClick={() => {
              onSelectFeed(null);
              onSelectCategory(item.categoryId);
            }}
          >
            <item.icon className={cn("w-5 h-5", isActiveNav ? "text-sidebar-accent-foreground" : "text-sidebar-foreground")} />
            {item.count !== null && showsCount(countDisplay, item.id === "all" ? "total" : "group") && (
              <UnreadCount count={item.count} className="absolute -bottom-1 inset-x-0 text-center text-caption" />
            )}
          </Button>
          );
        })}
      </aside>
    );
  }

  return (
    <CountDisplayContext.Provider value={countDisplay}>
    <aside role="navigation" aria-label={t("sidebar.feedNavigation")} className="h-full w-full bg-sidebar/85 backdrop-blur-overlay border-e border-sidebar-border/70 flex flex-col overflow-hidden">
      {/* Header (hidden on the compact Feeds screen, which has its own large title) */}
      <div className="ff-sidebar-header p-5 border-b border-sidebar-border/70">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-4">
            {branding.instanceIconDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={branding.instanceIconDataUrl}
                alt={`${branding.instanceName} logo`}
                className="h-12 w-12 rounded-panel object-cover"
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
              <h1 className="text-title font-semibold text-sidebar-foreground tracking-title">
                {branding.instanceName}
              </h1>
              <p
                className="text-body-sm text-muted-foreground"
                // No aria-live: the shell's live region announces the count on scope change only (spec §4.9.8).
                aria-label={showsCount(countDisplay, "total") ? t("sidebar.unreadAriaLabel", { count: totalUnread }) : undefined}
              >
                {showsCount(countDisplay, "total") && (
                  <>
                    <span className="tabular-nums" data-unread-count={totalUnread}>
                      {totalUnread > 99 ? "99+" : totalUnread}
                    </span>{" "}
                    {t("sidebar.unreadSuffix")}
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="w-8 h-8 rounded-panel shrink-0"
              onClick={() => window.dispatchEvent(new Event('focus-search'))}
              aria-label={t("sidebar.searchArticles")}
            >
              <Search className="w-4 h-4" />
            </Button>
            {headerAction}
          </div>
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
                  onSelectCategory(item.categoryId);
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3.5 py-2 rounded-panel text-body-sm transition-all",
                  selectedFeed === null &&
                    selectedCategory === item.categoryId
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                )}
              >
                <item.icon className="w-5 h-5" />
                <span className="flex-1 text-start">{item.label}</span>
                {item.count !== null && showsCount(countDisplay, item.id === "all" ? "total" : "group") && <UnreadCount count={item.count} />}
              </button>
            ))}
          </nav>

          {(savedSearches.length > 0 || visibleLabels.length > 0) && (
            <div className="mb-8 space-y-5">
              {savedSearches.length > 0 && (
                <div className="space-y-1">
                  <div className="px-4 pb-1">
                    <span className="text-footnote font-bold uppercase tracking-wider text-muted-foreground">
                      {t("sidebar.savedSearches")}
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
                        "w-full flex items-center gap-3 px-3.5 py-2 rounded-panel text-body-sm transition-all",
                        selectedFeed === null &&
                          selectedCategory === `Search:${item.id}`
                          ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                      )}
                    >
                      <Bookmark className="h-4 w-4 text-muted-foreground" />
                      <span className="flex-1 truncate text-start">
                        {item.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {visibleLabels.length > 0 && (
                <div className="space-y-1">
                  <div className="px-4 pb-1">
                    <span className="text-footnote font-bold uppercase tracking-wider text-muted-foreground">
                      {t("sidebar.labels")}
                    </span>
                  </div>
                  {visibleLabels.map((item: any) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        onSelectFeed(null);
                        onSelectCategory(`Label:${item.id}`);
                      }}
                      className={cn(
                        "w-full flex items-center gap-3 px-3.5 py-2 rounded-panel text-body-sm transition-all",
                        selectedFeed === null &&
                          selectedCategory === `Label:${item.id}`
                          ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                      )}
                    >
                      <Tag className="h-4 w-4" style={{ color: item.color }} />
                      <span className="flex-1 truncate text-start">
                        {item.name}
                      </span>
                      {showsCount(countDisplay, "group") && <UnreadCount count={item._count?.articles ?? 0} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Feeds Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between px-4">
              <span className="text-body-sm font-bold uppercase tracking-wider text-muted-foreground">
                {t("sidebar.feeds")}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="w-8 h-8 rounded-panel"
                onClick={onAddFeed}
                aria-label={t("sidebar.addFeed")}
              >
                <Plus className="w-5 h-5" />
              </Button>
            </div>


            {feeds.length === 0 ? (
              <Empty className="border-0 py-6">
                <EmptyMedia variant="icon"><Rss className="size-6" /></EmptyMedia>
                <EmptyContent>
                  <EmptyTitle>{t("sidebar.noFeedsYet")}</EmptyTitle>
                  <EmptyDescription>{t("sidebar.noFeedsYetDescription")}</EmptyDescription>
                  <Button
                    size="sm"
                    className="mt-3 rounded-panel"
                    onClick={onAddFeed}
                  >
                    <Plus className="w-4 h-4 me-1.5" />
                    {t("sidebar.addFeed")}
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
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
                  {allCategories.map((category: any) => {
                    const categoryFeeds = visibleFeeds.filter((f) => f.categoryId === category.id);
                    if (hideEmptyFeeds && categoryFeeds.length === 0) return null;
                    return (
                      <SortableCategory
                        key={category.id}
                        category={category}
                        feeds={categoryFeeds}
                        selectedFeed={selectedFeed}
                        selectedCategory={selectedCategory}
                        onSelectFeed={onSelectFeed}
                        expanded={expandedCategories.includes(category.id)}
                        onToggle={() => toggleCategory(category.id)}
                        renderFeedRow={renderFeedRow}
                        onSelectCategory={onSelectCategory}
                        canDeleteEmpty={isDeletableEmptyCategory(category.id, feeds, allCategories)}
                        onDeleteEmpty={() => setCategoryToDelete({ id: category.id, name: category.name })}
                      />
                    );
                  })}

                  {/* Uncategorized Feeds */}
                  <UncategorizedGroup
                    feeds={visibleFeeds.filter((f) => !f.categoryId)}
                    renderFeedRow={renderFeedRow}
                  />
                </div>
              </SortableContext>
            </DndContext>
            )}
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
                      className="h-11 w-11 rounded-panel sm:h-9 sm:w-9"
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
                    className="h-11 w-11 rounded-panel sm:h-9 sm:w-9"
                    aria-label={t("sidebar.manageFeeds")}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="currentColor" d="M4 4c-1.11 0-2 .89-2 2v12a2 2 0 0 0 2 2h8.08a7 7 0 0 1-.08-1a7 7 0 0 1 7-7a7 7 0 0 1 3 .69V8a2 2 0 0 0-2-2h-8l-2-2zm14 10a.26.26 0 0 0-.26.21l-.19 1.32c-.3.13-.59.29-.85.47l-1.24-.5c-.11 0-.24 0-.31.13l-1 1.73c-.06.11-.04.24.06.32l1.06.82a4.2 4.2 0 0 0 0 1l-1.06.82a.26.26 0 0 0-.06.32l1 1.73c.06.13.19.13.31.13l1.24-.5c.26.18.54.35.85.47l.19 1.32c.02.12.12.21.26.21h2c.11 0 .22-.09.24-.21l.19-1.32c.3-.13.57-.29.84-.47l1.23.5c.13 0 .26 0 .33-.13l1-1.73a.26.26 0 0 0-.06-.32l-1.07-.82c.02-.17.04-.33.04-.5s-.01-.33-.04-.5l1.06-.82a.26.26 0 0 0 .06-.32l-1-1.73c-.06-.13-.19-.13-.32-.13l-1.23.5c-.27-.18-.54-.35-.85-.47l-.19-1.32A.236.236 0 0 0 20 14zm1 3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5c-.84 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5" />
                    </svg>
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="top">{t("sidebar.manageFeeds")}</TooltipContent>
            </Tooltip>
            {session?.user?.role === "ADMIN" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link href="/server-settings">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 rounded-panel sm:h-9 sm:w-9"
                      aria-label={t("sidebar.serverSettings")}
                    >
                      <Cog className="w-4 h-4" />
                    </Button>
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="top">{t("sidebar.serverSettings")}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenu open={notificationsOpen} onOpenChange={setNotificationsOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-11 w-11 rounded-panel sm:h-9 sm:w-9 relative",
                        unreadNotifications ? "bg-accent text-accent-foreground" : "",
                      )}
                      aria-label={t("sidebar.notifications")}
                    >
                      <Bell className="w-4 h-4" />
                      {unreadNotifications > 0 && (
                        <span className="absolute -end-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-background bg-destructive px-1 text-caption font-bold leading-none text-destructive-foreground">
                          {unreadNotifications > 9 ? "9+" : unreadNotifications}
                        </span>
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" side="top" className="w-80 rounded-panel border-border/70 p-2">
                    <div className="flex items-center justify-between px-2 py-1.5">
                      <p className="text-body-sm font-semibold">{t("sidebar.notifications")}</p>
                      <div className="flex items-center gap-3">
                        {unreadNotifications > 0 && (
                          <button
                            className="hidden sm:inline text-footnote text-link hover:underline"
                            onClick={() => markAllNotificationsRead.mutate()}
                          >
                            {t("sidebar.markAllRead")}
                          </button>
                        )}
                        {notifications.length > 0 && (
                          <button
                            type="button"
                            data-testid="notifications-clear-all"
                            className="text-footnote text-link hover:underline"
                            onClick={() => {
                              setNotificationsOpen(false);
                              setClearNotificationsOpen(true);
                            }}
                          >
                            {t("sidebar.clearAllNotifications")}
                          </button>
                        )}
                      </div>
                    </div>
                    <DropdownMenuSeparator />
                    {notifications.length === 0 ? (
                      <div className="px-2 py-8 text-center">
                        <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-row bg-muted">
                          <Bell className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <p className="text-body-sm font-medium text-foreground">{t("sidebar.noNotifications")}</p>
                        <p className="mt-0.5 text-footnote text-muted-foreground">{t("sidebar.noNotificationsDescription")}</p>
                      </div>
                    ) : (
                      (notifications as any[]).slice(0, 8).map((notification: any) => {
                        const typeIcon = notification.type === "feed_error"
                          ? <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                          : notification.type === "feed_auto_muted"
                          ? <BellOff className="h-3.5 w-3.5 text-warning" />
                          : notification.type === "rule_match"
                          ? <Play className="h-3.5 w-3.5 text-muted-foreground" />
                          : notification.type === "digest_sent"
                          ? <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                          : <Bell className="h-3.5 w-3.5 text-accent" />;
                        return (
                          <DropdownMenuItem
                            key={notification.id}
                            className="items-start gap-3 rounded-panel px-2 py-2"
                            data-testid="notification-item"
                            onKeyDown={(e) => {
                              if (e.key === "Delete" || e.key === "Backspace") {
                                e.preventDefault();
                                dismissNotification.mutate(notification.id);
                              }
                            }}
                            onClick={() => {
                              if (!notification.isRead) markNotificationRead.mutate(notification.id);
                              if (notification.articleId) {
                                if (onOpenArticle) onOpenArticle(notification.articleId);
                                else window.location.href = `/?a=${encodeURIComponent(notification.articleId)}`;
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
                              <span className="block truncate text-body-sm font-medium">{notification.title}</span>
                              <span className="line-clamp-2 text-footnote text-muted-foreground">
                                {notification.body}
                              </span>
                            </span>
                            <button
                              type="button"
                              aria-label={t("sidebar.dismissNotification")}
                              title={t("sidebar.dismissNotification")}
                              data-testid="notification-dismiss"
                              className="-me-1 flex size-6 shrink-0 items-center justify-center rounded-row text-muted-foreground hover:bg-muted hover:text-foreground"
                              onPointerUp={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                dismissNotification.mutate(notification.id);
                              }}
                            >
                              <X className="size-3.5" aria-hidden />
                            </button>
                          </DropdownMenuItem>
                        );
                      })
                    )}
                    {unreadNotifications > 0 && (
                      <>
                        <DropdownMenuSeparator className="sm:hidden" />
                        <button
                          type="button"
                          className="sm:hidden mt-1 w-full rounded-panel bg-primary px-3 py-3 text-body-sm font-semibold text-primary-foreground active:scale-[0.98] transition-transform"
                          onClick={() => markAllNotificationsRead.mutate()}
                        >
                          {t("sidebar.markAllAsRead")}
                        </button>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TooltipTrigger>
              <TooltipContent side="top">{t("sidebar.notifications")}</TooltipContent>
            </Tooltip>
            {session?.user && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 rounded-panel sm:h-9 sm:w-9"
                    onClick={() => setSignOutConfirmOpen(true)}
                    aria-label={t("sidebar.signOut")}
                  >
                    <LogOut className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{t("sidebar.signOut")}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </TooltipProvider>
      </div>


    </aside>

    <AlertDialog open={clearNotificationsOpen} onOpenChange={setClearNotificationsOpen}>
      <AlertDialogContent data-testid="notifications-clear-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("sidebar.clearNotificationsTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("sidebar.clearNotificationsDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => clearAllNotifications.mutate()}>{t("sidebar.clearNotificationsConfirm")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={!!markAllFeed} onOpenChange={(open) => !open && setMarkAllFeed(null)}>
      <AlertDialogContent data-testid="feeds-mark-all-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("feedsScreen.markAllTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("feedsScreen.markAllDescription", { count: markAllFeed?.unread ?? 0, name: markAllFeed?.name ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (markAllFeed) markViewRead({ feedId: markAllFeed.id, category: null });
              setMarkAllFeed(null);
            }}
          >
            {t("feedsScreen.markAllConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <DeleteEmptyCategoryDialog category={categoryToDelete} onClose={() => setCategoryToDelete(null)} />

    <AlertDialog open={!!feedToDelete} onOpenChange={(open) => !open && setFeedToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("sidebar.deleteConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("sidebar.deleteConfirmDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              if (!feedToDelete) return;
              deleteFeedMutation.mutate(feedToDelete.id, {
                onSuccess: () => toast.success(t("sidebar.errors.deleted")),
                onError: () => toast.error(t("sidebar.errors.couldNotDelete")),
              });
              setFeedToDelete(null);
            }}
          >
            {t("sidebar.deleteFeed")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={signOutConfirmOpen} onOpenChange={setSignOutConfirmOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("sidebar.signOutConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("sidebar.signOutConfirmDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => signOut()}>
            {t("sidebar.signOut")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </CountDisplayContext.Provider>
  );
}

function SortableCategory({
  category,
  feeds,
  selectedFeed,
  selectedCategory,
  onSelectFeed,
  expanded,
  onToggle,
  renderFeedRow,
  onSelectCategory,
  canDeleteEmpty,
  onDeleteEmpty,
}: any) {
  const t = useTranslations();
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
    zIndex: isDragging ? "var(--z-overlay)" : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  const countDisplay = useContext(CountDisplayContext);
  const isActiveCategory = selectedFeed === null && selectedCategory === categoryKey(category.id);
  const categoryUnreadCount = feeds.reduce((sum: number, f: any) => sum + (f.unreadCount || 0), 0);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group w-full overflow-hidden"
    >
      <div
        className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-row transition-colors",
          isActiveCategory
            ? "border-s-2 border-s-brand"
            : "hover:bg-sidebar-accent/30",
        )}
      >
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing hover:bg-muted p-1 rounded-chip transition-colors"
        >
          <GripVertical className="w-3.5 h-3.5 text-muted-foreground/50" />
        </div>
        <button
          onClick={() => onSelectCategory?.(categoryKey(category.id))}
          className={cn(
            "flex-1 flex items-center text-footnote font-bold uppercase tracking-wider transition-colors",
            isActiveCategory
              ? "text-brand"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span>{category.name}</span>
        </button>
        {!expanded && showsCount(countDisplay, "group") && <UnreadCount count={categoryUnreadCount} />}
        <button
          onClick={onToggle}
          className="p-1 rounded-chip hover:bg-muted transition-colors"
          aria-expanded={expanded}
          aria-label={expanded ? t("sidebar.collapseCategory", { name: category.name }) : t("sidebar.expandCategory", { name: category.name })}
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
        <div className="ps-4 pe-2 border-s border-sidebar-border/50 py-1 space-y-0.5 overflow-hidden">
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
            <p className="text-footnote text-muted-foreground px-3 py-1">
              <span className="italic">{t("sidebar.noFeeds")}</span>
              {canDeleteEmpty && (
                <>
                  <span aria-hidden> · </span>
                  <button
                    type="button"
                    data-testid="delete-empty-category"
                    className="rounded-chip underline underline-offset-2 transition-colors hover:text-destructive focus-visible:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t("sidebar.deleteCategoryNamed", { name: category.name })}
                    onClick={onDeleteEmpty}
                  >
                    {t("sidebar.deleteCategoryAction")}
                  </button>
                </>
              )}
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
    zIndex: isDragging ? "var(--z-overlay)" : undefined,
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
  const t = useTranslations();
  const countDisplay = useContext(CountDisplayContext);
  return (
    <button
      onClick={onSelect}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-1.5 rounded-row text-body-sm transition-all group min-w-0",
        isSelected
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-sidebar-foreground",
      )}
    >
      <div className="w-5 h-5 shrink-0 rounded-control overflow-hidden bg-muted flex items-center justify-center">
        {isNewsletterFeed(feed) ? (
          <NewsletterIcon size={20} />
        ) : feed.url ? (() => {
          try {
            const hostname = new URL(feed.url).hostname;
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`https://www.google.com/s2/favicons?domain=${hostname}&sz=32`}
                alt=""
                className="w-5 h-5"
                referrerPolicy="no-referrer"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            );
          } catch {
            return <span className="text-footnote">{feed.icon || "📰"}</span>;
          }
        })() : (
          <span className="text-footnote">{feed.icon || "📰"}</span>
        )}
      </div>
      <span className={cn("flex-1 text-start truncate font-medium", isSelected && "font-semibold")}>{feed.name}</span>
      {feed.lastStatus === "error" && (
        <span title={feed.lastError || t("sidebar.lastSyncFailed")}>
          <AlertCircle className={cn("h-3.5 w-3.5 shrink-0 text-destructive", isSelected && "text-primary-foreground/70")} />
        </span>
      )}
      {!hideUnreadBadge && showsCount(countDisplay, "feed") && (
        <UnreadCount count={feed.unreadCount} className={cn(isSelected && "text-primary-foreground/80")} />
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
  const t = useTranslations();
  const tNl = useTranslations("newsletterReader");
  const newsletter = isNewsletterFeed(feed);
  const websiteUrl = (() => {
    try {
      // Newsletter feeds have no fetchable URL ("newsletter:…"); their site is htmlUrl.
      const origin = new URL(newsletter ? feed.htmlUrl ?? "" : feed.url).origin;
      return /^https?:/.test(origin) ? origin : null;
    } catch {
      return null;
    }
  })();
  // Same overlay as every other "…" (sheet on compact touch, dropdown with a
  // mouse) and a nav overlay: system Back closes it, not the Feeds screen.
  const [open, setOpen] = useOwnedOverlay("feed-menu");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<{ mode: "sheet" | "menu"; anchor: { x: number; y: number } }>({ mode: "menu", anchor: { x: 0, y: 0 } });
  // Act once the menu's history entry is gone: "Bearbeiten" / "Feed-Zustand"
  // push another route, which must not race the overlay's history.back().
  const afterClose = (fn: () => void) => () => void nav.closeOverlay("feed-menu").then(fn);
  // Dialogs mount once the menu is gone (a vaul sheet unmounting under it would leave <body> inert).
  const confirmAfterClose = (fn: () => void) => afterClose(() => window.requestAnimationFrame(() => window.setTimeout(fn, 0)));
  const newsletterDialogs = useNewsletterDialogs();
  const newsletterActions = useNewsletterFeedActions(feed.id, open && newsletter);
  const nlInfo = newsletterActions.data ?? null;
  const items: OverlayMenuItem[] = [
    // Newsletter feeds are filled by mail: nothing to refresh, no fetch health.
    ...(newsletter ? [] : [{ id: "refresh", label: t("sidebar.refreshFeed"), icon: RefreshCw, onSelect: onRefresh }]),
    // "…": it asks first. Opened once the menu (a sheet in the tablet drawer on touch) is gone.
    { id: "mark-read", label: `${t("sidebar.markAllAsRead")}…`, icon: CheckCheck, disabled: !(feed.unreadCount > 0), onSelect: afterClose(onMarkRead) },
    ...(websiteUrl ? [{ id: "website", label: t("sidebar.openWebsite"), icon: ExternalLink, onSelect: () => window.open(websiteUrl, "_blank", "noopener,noreferrer") }] : []),
    { id: "edit", label: t("sidebar.editFeed"), icon: Pencil, separated: true, onSelect: afterClose(onEdit) },
    ...(newsletter ? [] : [{ id: "health", label: t("sidebar.feedHealth"), icon: Activity, onSelect: afterClose(onShowHealth) }]),
    ...(newsletter
      ? [
          {
            id: "newsletter-unsubscribe",
            label: tNl("menuUnsubscribe"),
            icon: MailX,
            separated: true,
            disabled: !nlInfo,
            onSelect: confirmAfterClose(() => nlInfo && newsletterDialogs.openUnsubscribe({ feedId: feed.id }, nlInfo)),
          },
          ...(nlInfo?.blockAddress
            ? [{ id: "newsletter-block", label: tNl("menuBlock"), icon: Ban, onSelect: confirmAfterClose(() => newsletterDialogs.openBlock({ feedId: feed.id }, nlInfo)) }]
            : []),
        ]
      : []),
    { id: "delete", label: t("sidebar.deleteFeed"), icon: Trash2, separated: true, danger: true, onSelect: afterClose(onDelete) },
  ];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("sidebar.feedActions")}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="feed-menu-button"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setPlacement({
            mode: getLayoutClass() === "compact" && isCoarsePointer() ? "sheet" : "menu",
            anchor: { x: Math.max(8, r.right - 256), y: r.bottom + 4 },
          });
          setOpen(true);
        }}
        className="shrink-0 w-7 h-7 rounded-row flex items-center justify-center text-muted-foreground/80 hover:text-foreground hover:bg-sidebar-accent/60 transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <ResponsiveMenu
          open={open}
          onOpenChange={setOpen}
          mode={placement.mode}
          title={feed.name ?? t("sidebar.feedActions")}
          anchor={placement.anchor}
          items={items}
          testId="feed-menu"
          returnFocus={() => triggerRef.current}
        />
      )}
      {newsletter && newsletterDialogs.element}
    </>
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
  const t = useTranslations();
  if (feeds.length === 0) return null;
  return (
    <div className="py-2">
      <div className="px-4 py-2">
        <h3 className="text-footnote font-bold text-muted-foreground uppercase tracking-wider">
          {t("sidebar.uncategorized")}
        </h3>
      </div>
      <div className="ps-4 pe-2 py-1 space-y-0.5">
        {feeds.map((feed: any) => renderFeedRow(feed))}
      </div>
    </div>
  );
}
