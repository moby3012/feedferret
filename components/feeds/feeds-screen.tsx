"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import {
  Activity,
  AlertCircle,
  Bell,
  Bookmark,
  CheckCheck,
  ChevronRight,
  Cog,
  ExternalLink,
  Hand,
  Inbox,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Star,
  Tag,
  Trash2,
  MailX,
  Ban,
  type LucideIcon,
} from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ResponsiveMenu, type OverlayMenuItem } from "@/components/ui/responsive-overlay";
import { UnreadCount } from "@/components/ui/unread-count";
import { SpoilerIcon } from "@/components/icons/spoiler-icon";
import { FeedFavicon } from "@/components/list/feed-favicon";
import { useNewsletterDialogs, useNewsletterFeedActions } from "@/components/newsletter/newsletter-actions";
import { isNewsletterFeed } from "@/lib/newsletter-constants";
import { useShellActions, useShellData } from "@/components/shell/shell-context";
import { useCountsQuery } from "@/features/bootstrap/queries";
import { EMPTY_COUNTS } from "@/features/bootstrap/types";
import type { Scope } from "@/features/articles/scope";
import { isCoarsePointer } from "@/features/reader/layout/layout-class";
import { markViewScopeOf } from "@/features/reader/nav/sidebar-keys";
import { getNavState, nav, useNav } from "@/features/reader/nav/store";
import { useOwnedOverlay } from "@/features/reader/nav/use-owned-overlay";
import { useArticleActions } from "@/features/articles/mutations";
import {
  useDeleteFeed,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useRefreshFeed,
} from "@/hooks/use-rss-data";
import { parseCountDisplay, showsCount, type CountDisplay } from "@/lib/count-display";
import { completeFeedsHint, createSwipeRow, documentDir, useFeedsHintDue, useTouchRows, type LongPressPoint } from "@/lib/gestures";
import { markInAppNavigation } from "@/lib/in-app-back";
import { useSignOut } from "@/components/shell/use-sign-out";
import { isDeletableEmptyCategory } from "@/lib/empty-category";
import { DeleteEmptyCategoryDialog } from "@/components/delete-empty-category-dialog";
import { cn } from "@/lib/utils";

// Compact Feeds screen (Feeds tab root, audit-ux-2 A-03 / R3): a Reeder-style
// list — smart views and labels on top (owner decision 2026-11-10: kept, but
// they drill down inside the Feeds tab, Back → here), folders collapsible with
// their unread sums, feed rows with favicon / name / unread. Rows carry no
// buttons on touch: long-press (or right-click / the context-menu key) opens
// the feed's actions; "mark all read" always asks first (no gesture mark-all).
// A one-time tip explains the long-press (lib/gestures/coach.ts). The expanded
// sidebar and the tablet drawer keep the legacy tree (components/rss-sidebar).

/** Expanded folders, per device. */
const EXPANDED_KEY = "ff:feeds-expanded";

function readExpanded(): string[] {
  try {
    const raw = window.localStorage.getItem(EXPANDED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeExpanded(ids: string[]) {
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(ids));
  } catch {
    /* private mode: this page view only */
  }
}

/** Where the header "…" was tapped (the menu anchors there with a mouse). */
let headerMenuAnchor: { x: number; y: number; sheet: boolean } = { x: 0, y: 0, sheet: true };

/** The header "…" (static markup in components/shell/sources-pane.tsx) opens the Feeds menu. */
export function openFeedsMenu(trigger: HTMLElement, pointerType: string) {
  const r = trigger.getBoundingClientRect();
  headerMenuAnchor = {
    x: Math.max(8, r.right - 256),
    y: r.bottom + 4,
    sheet: pointerType === "touch" || pointerType === "pen" || (pointerType !== "mouse" && isCoarsePointer()),
  };
  void nav.openOverlay("feeds-menu");
}

const open = (scope: Scope) => void nav.goScope(scope, { inFeeds: true });

interface FeedItem {
  id: string;
  name: string;
  url?: string | null;
  siteUrl?: string | null;
  icon?: string | null;
  categoryId?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  /** Newsletter feed (envelope icon; no refresh / health actions). */
  newsletter: boolean;
  unread: number;
}

type MenuTarget =
  | { kind: "feed"; feed: FeedItem; point: LongPressPoint; returnFocus: HTMLElement | null }
  | { kind: "category"; id: string; name: string; unread: number; point: LongPressPoint; returnFocus: HTMLElement | null };

type MarkAllTarget = { scope: Scope; name: string; unread: number };

export function FeedsScreen() {
  const t = useTranslations("feedsScreen");
  const tCommon = useTranslations("common");
  const tSidebar = useTranslations("sidebar");
  const tNl = useTranslations("newsletterReader");
  const router = useRouter();
  const { feeds, feedsLoaded, categories, labels, savedSearches, prefs } = useShellData();
  const shell = useShellActions();
  const counts = useCountsQuery(true).data ?? EMPTY_COUNTS;
  const countDisplay = parseCountDisplay(prefs?.countDisplay);
  const hideEmptyFeeds = prefs?.hideEmptyFeeds ?? false;
  const hideEmptyLabels = prefs?.hideEmptyLabels ?? false;

  const [expanded, setExpanded] = useState<string[]>([]);
  useEffect(() => setExpanded(readExpanded()), []);
  const toggleFolder = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id];
      writeExpanded(next);
      return next;
    });
  }, []);

  const items: FeedItem[] = useMemo(
    () =>
      (feeds as any[]).map((f) => ({
        id: f.id,
        name: f.name ?? f.title ?? f.url ?? "",
        url: f.url,
        siteUrl: f.siteUrl ?? f.link ?? null,
        icon: f.icon,
        categoryId: f.categoryId ?? null,
        lastStatus: f.lastStatus,
        lastError: f.lastError,
        newsletter: isNewsletterFeed(f),
        unread: counts.byFeed[f.id] ?? 0,
      })),
    [feeds, counts.byFeed],
  );
  const visible = hideEmptyFeeds ? items.filter((f) => f.unread > 0) : items;
  const visibleLabels = (labels as any[]).filter((l) => !hideEmptyLabels || (counts.byLabel[l.id] ?? l._count?.articles ?? 0) > 0);

  // ---------------------------------------------------------------- menus
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [menuOpen, setMenuOpen] = useOwnedOverlay("feed-menu");
  const [markAll, setMarkAll] = useState<MarkAllTarget | null>(null);
  const [feedToDelete, setFeedToDelete] = useState<{ id: string; name: string } | null>(null);
  // Inline "Delete category" of an empty folder's "No feeds" line.
  const [categoryToDelete, setCategoryToDelete] = useState<{ id: string; name: string } | null>(null);
  const refreshFeed = useRefreshFeed();
  const deleteFeed = useDeleteFeed();
  const { markViewRead } = useArticleActions();
  const newsletterDialogs = useNewsletterDialogs();

  const openMenu = useCallback(
    (target: MenuTarget) => {
      // One menu per gesture: the context-menu key also fires `contextmenu` (keydown + event → one overlay entry).
      if (getNavState().overlay === "feed-menu") return;
      if (target.point.pointerType === "touch" || target.point.pointerType === "pen") completeFeedsHint();
      setMenu(target);
      setMenuOpen(true);
    },
    [setMenuOpen],
  );
  // Act once the menu's history entry is gone (a route push must not race its history.back()).
  const afterClose = (fn: () => void) => () => void nav.closeOverlay("feed-menu").then(fn);
  // A confirm dialog opens only once the menu (a vaul sheet on touch) is gone: mounted while
  // the sheet unmounts, Radix would restore the sheet's `pointer-events: none` on <body>.
  const confirmAfterClose = (fn: () => void) => afterClose(() => window.requestAnimationFrame(() => window.setTimeout(fn, 0)));
  const goRoute = (href: string) => {
    markInAppNavigation();
    router.push(href);
  };

  const menuNewsletterFeed = menu?.kind === "feed" && menu.feed.newsletter ? menu.feed.id : null;
  const newsletterActions = useNewsletterFeedActions(menuNewsletterFeed ?? "", menuOpen && menuNewsletterFeed !== null);
  const menuItems: OverlayMenuItem[] = !menu
    ? []
    : menu.kind === "feed"
      ? feedMenuItems(menu.feed)
      : [
          { id: "open", label: t("openFolder"), icon: Inbox, onSelect: afterClose(() => open({ kind: "category", id: menu.id })) },
          {
            id: "mark-read",
            label: `${tSidebar("markAllAsRead")}…`,
            icon: CheckCheck,
            disabled: menu.unread === 0,
            onSelect: confirmAfterClose(() => setMarkAll({ scope: { kind: "category", id: menu.id }, name: menu.name, unread: menu.unread })),
          },
          { id: "manage", label: tSidebar("manageFeeds"), icon: Pencil, separated: true, onSelect: afterClose(() => goRoute("/manage-feeds")) },
        ];

  function feedMenuItems(feed: FeedItem): OverlayMenuItem[] {
    const website = (() => {
      try {
        // A newsletter's url is "newsletter:…" (origin "null"): only its site link counts.
        const origin = new URL((feed.newsletter ? feed.siteUrl : feed.siteUrl || feed.url) || "").origin;
        return /^https?:/.test(origin) ? origin : null;
      } catch {
        return null;
      }
    })();
    const nlInfo = feed.newsletter ? (newsletterActions.data ?? null) : null;
    return [
      // Newsletter feeds are filled by mail: nothing to refresh, no fetch health.
      ...(feed.newsletter ? [] : [{ id: "refresh", label: tSidebar("refreshFeed"), icon: RefreshCw, onSelect: () => refreshFeed.mutate(feed.id) }]),
      {
        id: "mark-read",
        // "…": it asks first (owner decision: never a one-tap / gesture mark-all).
        label: `${tSidebar("markAllAsRead")}…`,
        icon: CheckCheck,
        disabled: feed.unread === 0,
        onSelect: confirmAfterClose(() => setMarkAll({ scope: { kind: "feed", id: feed.id }, name: feed.name, unread: feed.unread })),
      },
      ...(website ? [{ id: "website", label: tSidebar("openWebsite"), icon: ExternalLink, onSelect: () => window.open(website, "_blank", "noopener,noreferrer") }] : []),
      { id: "edit", label: tSidebar("editFeed"), icon: Pencil, separated: true, onSelect: afterClose(() => goRoute(`/manage-feeds?feedId=${encodeURIComponent(feed.id)}`)) },
      ...(feed.newsletter ? [] : [{ id: "health", label: tSidebar("feedHealth"), icon: Activity, onSelect: afterClose(() => goRoute("/manage-feeds?tab=health")) }]),
      ...(feed.newsletter
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
      { id: "delete", label: tSidebar("deleteFeed"), icon: Trash2, separated: true, danger: true, onSelect: confirmAfterClose(() => setFeedToDelete({ id: feed.id, name: feed.name })) },
    ];
  }

  // ---------------------------------------------------------------- render
  const smart: Array<{ id: string; scope: Scope; icon: LucideIcon | typeof SpoilerIcon; label: string; count: number; kind: "total" | "group" }> = [
    { id: "all", scope: { kind: "all" }, icon: Inbox, label: tSidebar("allArticles"), count: counts.unreadTotal, kind: "total" },
    { id: "starred", scope: { kind: "starred" }, icon: Star, label: tSidebar("starred"), count: counts.starred, kind: "group" },
    { id: "later", scope: { kind: "later" }, icon: Bookmark, label: tSidebar("readLater"), count: counts.later, kind: "group" },
    ...(counts.spoiler > 0 ? [{ id: "spoiler", scope: { kind: "spoiler" } as Scope, icon: SpoilerIcon, label: tSidebar("spoiler"), count: counts.spoiler, kind: "group" as const }] : []),
  ];

  const byCategory = (id: string | null) => visible.filter((f) => (f.categoryId ?? null) === id);
  const uncategorized = byCategory(null).concat(
    // Feeds whose category is unknown to the client (deleted / not loaded yet) are not lost.
    visible.filter((f) => f.categoryId && !(categories as any[]).some((c) => c.id === f.categoryId)),
  );

  return (
    <div className="ff-feeds-scroller min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="feeds-screen">
      <nav aria-label={tSidebar("feedNavigation")} className="pb-6">
        <FeedsHint />

        <ul className="ff-feeds-group" aria-label={t("overview")}>
          {smart.map((item) => (
            <li key={item.id}>
              <RowButton
                icon={item.icon}
                label={item.label}
                count={showsCount(countDisplay, item.kind) ? item.count : 0}
                onClick={() => open(item.scope)}
              />
            </li>
          ))}
        </ul>

        {savedSearches.length > 0 && (
          <Section title={tSidebar("savedSearches")}>
            {(savedSearches as any[]).map((s) => (
              <li key={s.id}>
                <RowButton icon={Search} label={s.name} onClick={() => open({ kind: "saved-search", id: s.id })} />
              </li>
            ))}
          </Section>
        )}

        {visibleLabels.length > 0 && (
          <Section title={tSidebar("labels")}>
            {visibleLabels.map((l) => (
              <li key={l.id}>
                <RowButton
                  icon={Tag}
                  iconColor={l.color}
                  label={l.name}
                  count={showsCount(countDisplay, "group") ? counts.byLabel[l.id] ?? 0 : 0}
                  onClick={() => open({ kind: "label", id: l.id })}
                />
              </li>
            ))}
          </Section>
        )}

        <Section title={tSidebar("feeds")} testId="feeds-section">
          {feedsLoaded && items.length === 0 ? (
            <li>
              <Empty className="border-0 py-6">
                <EmptyMedia variant="icon">
                  <Rss className="size-6" />
                </EmptyMedia>
                <EmptyContent>
                  <EmptyTitle>{tSidebar("noFeedsYet")}</EmptyTitle>
                  <EmptyDescription>{tSidebar("noFeedsYetDescription")}</EmptyDescription>
                  <Button size="sm" className="mt-3" onClick={() => shell.requestAddFeed()}>
                    <Plus className="me-1.5 size-4" aria-hidden />
                    {tSidebar("addFeed")}
                  </Button>
                </EmptyContent>
              </Empty>
            </li>
          ) : (
            <>
              {(categories as any[]).map((c) => {
                const inFolder = byCategory(c.id);
                if (hideEmptyFeeds && inFolder.length === 0) return null;
                const unread = inFolder.reduce((sum, f) => sum + f.unread, 0);
                const isOpen = expanded.includes(c.id);
                return (
                  <li key={c.id}>
                    <FolderRow
                      id={c.id}
                      name={c.name}
                      unread={showsCount(countDisplay, "group") ? unread : 0}
                      expanded={isOpen}
                      onToggle={() => toggleFolder(c.id)}
                      onMenu={(point, el) => openMenu({ kind: "category", id: c.id, name: c.name, unread, point, returnFocus: el })}
                    />
                    {isOpen && (
                      <ul className="ff-feeds-folder" aria-label={c.name}>
                        {inFolder.length === 0 ? (
                          <li className="ff-feeds-empty-folder">
                            <span className="italic">{tSidebar("noFeeds")}</span>
                            {isDeletableEmptyCategory(c.id, items, categories as any[]) && (
                              <>
                                <span aria-hidden> · </span>
                                <button
                                  type="button"
                                  className="ff-feeds-empty-folder-action"
                                  data-testid="delete-empty-category"
                                  aria-label={tSidebar("deleteCategoryNamed", { name: c.name })}
                                  onClick={() => setCategoryToDelete({ id: c.id, name: c.name })}
                                >
                                  {tSidebar("deleteCategoryAction")}
                                </button>
                              </>
                            )}
                          </li>
                        ) : (
                          inFolder.map((f) => (
                            <li key={f.id}>
                              <FeedRow feed={f} nested countDisplay={countDisplay} onMenu={openMenu} />
                            </li>
                          ))
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
              {uncategorized.map((f) => (
                <li key={f.id}>
                  <FeedRow feed={f} countDisplay={countDisplay} onMenu={openMenu} />
                </li>
              ))}
            </>
          )}
        </Section>
      </nav>

      {menu && menuOpen && (
        <ResponsiveMenu
          open={menuOpen}
          onOpenChange={(next) => {
            setMenuOpen(next);
          }}
          mode={menu.point.pointerType === "mouse" || (menu.point.pointerType === "keyboard" && !isCoarsePointer()) ? "menu" : "sheet"}
          title={menu.kind === "feed" ? menu.feed.name : menu.name}
          anchor={{ x: menu.point.x, y: menu.point.y }}
          items={menuItems}
          testId="feed-menu"
          returnFocus={() => menu.returnFocus}
        />
      )}

      <FeedsHeaderMenu />

      <AlertDialog open={markAll !== null} onOpenChange={(o) => !o && setMarkAll(null)}>
        <AlertDialogContent data-testid="feeds-mark-all-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("markAllTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("markAllDescription", { count: markAll?.unread ?? 0, name: markAll?.name ?? "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (markAll) markViewRead(markViewScopeOf(markAll.scope));
                setMarkAll(null);
              }}
            >
              {t("markAllConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DeleteEmptyCategoryDialog category={categoryToDelete} onClose={() => setCategoryToDelete(null)} />
      {newsletterDialogs.element}

      <AlertDialog open={feedToDelete !== null} onOpenChange={(o) => !o && setFeedToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tSidebar("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{tSidebar("deleteConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (feedToDelete) {
                  deleteFeed.mutate(feedToDelete.id, {
                    onSuccess: () => toast.success(tSidebar("errors.deleted")),
                    onError: () => toast.error(tSidebar("errors.couldNotDelete")),
                  });
                }
                setFeedToDelete(null);
              }}
            >
              {tSidebar("deleteFeed")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="mt-5" data-testid={testId}>
      <h3 className="ff-feeds-heading">{title}</h3>
      <ul className="ff-feeds-group">{children}</ul>
    </section>
  );
}

/** A smart view / saved search / label row: icon, name, count. */
function RowButton({
  icon: Icon,
  iconColor,
  label,
  count = 0,
  onClick,
}: {
  icon: LucideIcon | typeof SpoilerIcon;
  iconColor?: string;
  label: string;
  count?: number;
  onClick(): void;
}) {
  return (
    <button type="button" className="ff-feeds-row" onClick={onClick}>
      <span className="ff-feeds-icon">
        <Icon className="size-5" style={iconColor ? { color: iconColor } : undefined} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-start">{label}</span>
      <UnreadCount count={count} />
    </button>
  );
}

/** Long-press (touch / pen), right-click and the context-menu key on one element: the row's menu. */
function useRowMenu(onMenu: (point: LongPressPoint, el: HTMLElement) => void) {
  const ref = useRef<HTMLButtonElement>(null);
  const live = useRef(onMenu);
  live.current = onMenu;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return createSwipeRow(el, {
      content: el,
      // No swipe actions on feed rows: a horizontal drag stays a scroll / OS gesture.
      enabled: () => false,
      dir: documentDir,
      leading: () => null,
      trailing: () => null,
      onLongPress: (point) => live.current(point, el),
    });
  }, []);
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      live.current({ x: r.left + Math.min(48, r.width / 2), y: r.bottom - 4, pointerType: "keyboard" }, e.currentTarget);
    }
  };
  return { ref, onKeyDown };
}

/**
 * Screen readers / keyboards on touch rows: one "Aktionen" button after the
 * row (visually hidden until focused, like the article rows); a mouse gets a
 * hover-revealed "…" (app/styles/shell.css).
 */
function RowActionsButton({ label, onOpen }: { label: string; onOpen(point: LongPressPoint, el: HTMLElement): void }) {
  const t = useTranslations("feedsScreen");
  return (
    <button
      type="button"
      className="ff-feeds-actions"
      aria-haspopup="menu"
      aria-label={label}
      data-testid="feed-menu-button"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const row = e.currentTarget.previousElementSibling as HTMLElement | null;
        // `e.detail === 0`: keyboard / assistive tech activation.
        const pointerType = e.detail === 0 ? "keyboard" : isCoarsePointer() ? "touch" : "mouse";
        onOpen({ x: Math.max(8, r.right - 256), y: r.bottom + 4, pointerType }, row ?? e.currentTarget);
      }}
    >
      <span className="ff-feeds-actions-label">{t("actionsShort")}</span>
      <span className="ff-feeds-actions-dots" aria-hidden>
        •••
      </span>
    </button>
  );
}

function FolderRow({
  id,
  name,
  unread,
  expanded,
  onToggle,
  onMenu,
}: {
  id: string;
  name: string;
  unread: number;
  expanded: boolean;
  onToggle(): void;
  onMenu(point: LongPressPoint, el: HTMLElement): void;
}) {
  const t = useTranslations("sidebar");
  const tScreen = useTranslations("feedsScreen");
  const { ref, onKeyDown } = useRowMenu(onMenu);
  return (
    <div className="ff-feeds-line" data-folder-id={id}>
      <button
        type="button"
        className="ff-feeds-chevron"
        aria-expanded={expanded}
        aria-label={expanded ? t("collapseCategory", { name }) : t("expandCategory", { name })}
        onClick={onToggle}
      >
        <ChevronRight className={cn("size-4 transition-transform duration-(--dur-fast) rtl:-scale-x-100", expanded && "rotate-90 rtl:rotate-90")} aria-hidden />
      </button>
      <button ref={ref} type="button" className="ff-feeds-row ps-0 font-semibold" onClick={() => open({ kind: "category", id })} onKeyDown={onKeyDown}>
        <span className="min-w-0 flex-1 truncate text-start">{name}</span>
        <UnreadCount count={unread} />
      </button>
      <RowActionsButton label={tScreen("actionsFor", { name })} onOpen={onMenu} />
    </div>
  );
}

function FeedRow({
  feed,
  nested = false,
  countDisplay,
  onMenu,
}: {
  feed: FeedItem;
  nested?: boolean;
  countDisplay: CountDisplay;
  onMenu(target: MenuTarget): void;
}) {
  const t = useTranslations("sidebar");
  const tScreen = useTranslations("feedsScreen");
  const menu = (point: LongPressPoint, el: HTMLElement) => onMenu({ kind: "feed", feed, point, returnFocus: el });
  const { ref, onKeyDown } = useRowMenu(menu);
  return (
    <div className="ff-feeds-line" data-feed-id={feed.id}>
      <button
        ref={ref}
        type="button"
        className="ff-feeds-row"
        data-nested={nested ? "" : undefined}
        onClick={() => open({ kind: "feed", id: feed.id })}
        onKeyDown={onKeyDown}
      >
        <span className="ff-feeds-icon">
          <FeedFavicon icon={feed.icon} name={feed.name} size={20} articleLink={feed.siteUrl || feed.url || undefined} newsletter={feed.newsletter} />
        </span>
        <span className="min-w-0 flex-1 truncate text-start">{feed.name}</span>
        {feed.lastStatus === "error" && (
          <span title={feed.lastError || t("lastSyncFailed")} className="shrink-0">
            <AlertCircle className="size-4 text-danger" aria-hidden />
          </span>
        )}
        {showsCount(countDisplay, "feed") && <UnreadCount count={feed.unread} />}
      </button>
      <RowActionsButton label={tScreen("actionsFor", { name: feed.name })} onOpen={menu} />
    </div>
  );
}

/**
 * One-time tip on touch devices (feed rows carry no buttons): "long-press a
 * feed or folder for its actions". Gone after "Verstanden" or the first
 * long-press; Settings → Gesten & Hilfe shows it again.
 */
function FeedsHint() {
  const t = useTranslations("feedsScreen");
  const tHint = useTranslations("gestureHint");
  const due = useFeedsHintDue();
  const touchRows = useTouchRows();
  if (!due || !touchRows) return null;
  return (
    <aside className="ff-gesture-hint" role="note" aria-label={tHint("label")} data-testid="feeds-hint">
      <Hand className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-body-sm font-semibold text-foreground">{t("hintTitle")}</p>
        <p className="mt-0.5 text-footnote text-muted-foreground">{t("hintBody")}</p>
        <div className="mt-2 flex items-center gap-2">
          <Button type="button" size="sm" onClick={() => completeFeedsHint()}>
            {tHint("dismiss")}
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link
              href="/settings?tab=gestures"
              onClick={() => {
                markInAppNavigation();
                completeFeedsHint();
              }}
            >
              {t("hintHelp")}
            </Link>
          </Button>
        </div>
      </div>
    </aside>
  );
}

/**
 * The header "…" menu (one entry per destination that has no tab): Feeds
 * verwalten · Server (admins) · Benachrichtigungen (an in-sheet step) ·
 * Abmelden. A nav overlay: Back closes it.
 */
function FeedsHeaderMenu() {
  const t = useTranslations("feedsScreen");
  const tCommon = useTranslations("common");
  const tSidebar = useTranslations("sidebar");
  const router = useRouter();
  const isOpen = useNav((s) => s.overlay === "feeds-menu");
  const { data: session } = useSession();
  const { data: notifications = [] } = useNotifications();
  const unreadNotifications = useCountsQuery(true).data?.notifications ?? 0;
  const markNotificationRead = useMarkNotificationRead();
  const markAllNotificationsRead = useMarkAllNotificationsRead();
  const signOut = useSignOut();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const afterClose = (fn: () => void) => () => void nav.closeOverlay("feeds-menu").then(fn);
  const go = (href: string) =>
    afterClose(() => {
      markInAppNavigation();
      router.push(href);
    });

  const notificationItems: OverlayMenuItem[] = [
    ...(notifications as any[]).slice(0, 8).map((n) => ({
      id: `n-${n.id}`,
      label: n.title,
      icon: n.type === "feed_error" ? AlertCircle : Bell,
      onSelect: () => {
        if (!n.isRead) markNotificationRead.mutate(n.id);
        if (n.articleId) void nav.openArticle(n.articleId);
      },
    })),
    ...(unreadNotifications > 0
      ? [{ id: "notifications-read", label: tSidebar("markAllRead"), icon: CheckCheck, separated: (notifications as any[]).length > 0, onSelect: () => markAllNotificationsRead.mutate() }]
      : []),
  ];
  const items: OverlayMenuItem[] = [
    { id: "manage", label: tSidebar("manageFeeds"), icon: Pencil, onSelect: go("/manage-feeds") },
    ...(session?.user?.role === "ADMIN" ? [{ id: "server", label: tSidebar("serverSettings"), icon: Cog, onSelect: go("/server-settings") }] : []),
    {
      id: "notifications",
      label: unreadNotifications > 0 ? t("notificationsUnread", { count: unreadNotifications }) : tSidebar("notifications"),
      icon: Bell,
      onSelect: () => {},
      children:
        notificationItems.length > 0
          ? notificationItems
          : [{ id: "notifications-empty", label: tSidebar("noNotifications"), disabled: true, onSelect: () => {} }],
    },
    { id: "gestures", label: t("gesturesHelp"), icon: Hand, onSelect: go("/settings?tab=gestures") },
    {
      id: "sign-out",
      label: tSidebar("signOut"),
      icon: LogOut,
      separated: true,
      // The confirm opens once the sheet is gone (see confirmAfterClose in FeedsScreen).
      onSelect: afterClose(() => window.requestAnimationFrame(() => window.setTimeout(() => setSignOutOpen(true), 0))),
    },
  ];

  return (
    <>
      {isOpen && (
        <ResponsiveMenu
          open={isOpen}
          onOpenChange={(next) => {
            if (!next) void nav.closeOverlay("feeds-menu");
          }}
          mode={headerMenuAnchor.sheet ? "sheet" : "menu"}
          title={t("menuTitle")}
          anchor={{ x: headerMenuAnchor.x, y: headerMenuAnchor.y }}
          items={items}
          testId="feeds-menu"
          returnFocus={() => document.querySelector<HTMLElement>('[data-testid="feeds-menu-button"]')}
        />
      )}
      <AlertDialog open={signOutOpen} onOpenChange={setSignOutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tSidebar("signOutConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{tSidebar("signOutConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => signOut({ callbackUrl: "/" })}>{tSidebar("signOut")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
