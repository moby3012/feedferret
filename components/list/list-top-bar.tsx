"use client";

import { formatUnreadCount, parseCountDisplay, showsCount } from "@/lib/count-display";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlignJustify,
  BookmarkPlus,
  Check,
  CheckCheck,
  ChevronLeft,
  LayoutGrid,
  List,
  MoreHorizontal,
  RefreshCw,
  SortAsc,
  SortDesc,
  type LucideIcon,
} from "lucide-react";
import { SearchField } from "@/components/search/search-field";
import { OfflineChip } from "@/components/shell/offline-chip";
import { useShellActions, useShellData, type ViewMode } from "@/components/shell/shell-context";
import { Chip } from "@/components/ui/chip";
import { ResponsiveMenu, type OverlayMenuItem } from "@/components/ui/responsive-overlay";
import { Segmented } from "@/components/ui/segmented";
import { showApplies, type Scope } from "@/features/articles/scope";
import { getLayoutClass, isCoarsePointer } from "@/features/reader/layout/layout-class";
import type { Loc, TabId } from "@/features/reader/nav/location";
import { nav, useNav } from "@/features/reader/nav/store";
import { cn } from "@/lib/utils";

// List top bar (spec §4.6): [leading][title 1fr][trailing].
//   leading   compact Feeds → feed: back chevron (one level up)
//   title     h2 (tap = scroll to top) + muted count (99+, hidden at 0)
//   trailing  filter chip "Unread" (aria-pressed) · wide: refresh, mark-all · "…"
// The "…" menu carries sort, layout, refresh, mark-all and save-search: the
// actions of the old compact bottom pill live here and in pull-to-refresh.
// Gemerkt: the title slot is the segmented control Später | Favoriten, plus
// the user's labels as chips. Suche: the title slot is the search field (the
// root has no scope: field only).

export interface ListTopBarProps {
  tab: TabId;
  /** `scope: null` only on the Suche root. */
  loc: Loc;
  title: string;
  unreadCount: number;
  active: boolean;
  isRefreshing: boolean;
  onMarkAllRead?: () => void;
  isMarkingAllRead: boolean;
  onScrollTop(): void;
  /** Suche with a query: "N matches · M unread". */
  resultSummary?: string;
}

const VIEW_MODES: { mode: ViewMode; icon: LucideIcon; key: "layoutList" | "layoutCompact" | "layoutMagazine" }[] = [
  { mode: "list", icon: List, key: "layoutList" },
  { mode: "minimal", icon: AlignJustify, key: "layoutCompact" },
  { mode: "magazine", icon: LayoutGrid, key: "layoutMagazine" },
];

const iconBtn =
  "hit-slop inline-flex size-10 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors duration-(--dur-press) hover:bg-surface-sunken hover:text-foreground active:bg-surface-sunken disabled:opacity-50";

export const ListTopBar = memo(function ListTopBar(p: ListTopBarProps) {
  const t = useTranslations("listBar");
  const tHeader = useTranslations("rssHeader");
  const data = useShellData();
  const shell = useShellActions();
  const headerRef = useRef<HTMLElement>(null);
  const { scope } = p.loc;
  const saved = p.tab === "saved" && !!scope;
  const search = p.tab === "search";
  const isQuery = scope?.kind === "query";
  const countText = formatUnreadCount(p.unreadCount);
  // "Zähler anzeigen" (spec §4.9.3): a feed's number is per-feed; every other scope is a group.
  const showCount = p.unreadCount > 0 && showsCount(parseCountDisplay(data.prefs?.countDisplay), scope?.kind === "feed" ? "feed" : "group");

  // Bar elevation once the list is scrolled (attribute only: no React render per scroll).
  useEffect(() => {
    const header = headerRef.current;
    const pane = header?.closest("[data-pane]");
    if (!header || !pane) return;
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement;
      if (el.dataset?.testid !== "list-scroller") return;
      header.toggleAttribute("data-scrolled", el.scrollTop > 4);
    };
    pane.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => pane.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  // "…" menu: a nav overlay (system Back closes it on touch / compact).
  const menuOpen = useNav((s) => p.active && s.overlay === "list-menu");
  const [menu, setMenu] = useState<{ mode: "sheet" | "menu"; anchor: { x: number; y: number } }>({ mode: "menu", anchor: { x: 0, y: 0 } });
  const openMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({
      mode: getLayoutClass() === "compact" && isCoarsePointer() ? "sheet" : "menu",
      anchor: { x: Math.max(8, r.right - 256), y: r.bottom + 4 },
    });
    void nav.openOverlay("list-menu");
  };
  const items: OverlayMenuItem[] = [
    {
      id: "sort",
      label: data.sortOrder === "oldest" ? tHeader("sortOldest") : tHeader("sortNewest"),
      icon: data.sortOrder === "oldest" ? SortAsc : SortDesc,
      onSelect: shell.toggleSort,
    },
    ...VIEW_MODES.map(({ mode, icon, key }, i) => ({
      id: `view-${mode}`,
      label: t(key),
      icon: data.viewMode === mode ? Check : icon,
      onSelect: () => shell.setViewMode(mode),
      separated: i === 0,
    })),
    { id: "refresh", label: t("refresh"), icon: RefreshCw, onSelect: shell.refresh, disabled: p.isRefreshing, separated: true },
    ...(p.onMarkAllRead
      ? [{ id: "mark-all", label: tHeader("markAllAsRead"), icon: CheckCheck, onSelect: p.onMarkAllRead, disabled: p.isMarkingAllRead }]
      : []),
    ...(scope?.kind === "query" ? [{ id: "save-search", label: tHeader("saveSearch"), icon: BookmarkPlus, onSelect: () => shell.saveSearch(scope.q) }] : []),
  ];

  const titleButton = (
    <button type="button" onClick={p.onScrollTop} className="flex min-h-11 min-w-0 max-w-full items-center gap-2 text-start">
      <h2 className="truncate text-title-sm text-foreground">{p.title}</h2>
      {showCount && (
        <span
          className="shrink-0 text-footnote tabular-nums text-muted-foreground"
          data-testid="list-count"
          data-count={p.unreadCount}
          title={t("unreadCount", { count: p.unreadCount })}
        >
          {countText}
        </span>
      )}
    </button>
  );

  return (
    <header ref={headerRef} className="ff-list-bar" data-testid="list-top-bar">
      <div className="ff-list-bar-row">
        {p.tab === "feeds" && (
          <button type="button" className={cn(iconBtn, "-ms-2 compact:inline-flex hidden text-foreground")} onClick={() => void nav.up()} aria-label={t("backToFeeds")}>
            <ChevronLeft className="size-6" aria-hidden />
          </button>
        )}
        <div className="min-w-0 flex-1" data-testid="list-bar-title">
          {search ? (
            <>
              <h2 className="sr-only">{p.title}</h2>
              <SearchField active={p.active} />
            </>
          ) : saved && scope ? (
            <>
              <h2 className="sr-only">{p.title}</h2>
              <SavedSegments scope={scope} />
            </>
          ) : (
            titleButton
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <OfflineChip />
          {scope && showApplies(scope) && !isQuery && (
            <Chip
              aria-pressed={p.loc.show === "unread"}
              onClick={() => void nav.setShow(p.loc.show === "unread" ? "all" : "unread")}
              data-testid="filter-chip"
            >
              {t("unreadFilter")}
            </Chip>
          )}
          {scope && !search && (
          <button
            type="button"
            className={cn(iconBtn, "hidden wide:inline-flex")}
            onClick={shell.refresh}
            disabled={p.isRefreshing}
            aria-label={tHeader("refreshFeeds")}
            title={tHeader("refreshFeeds")}
          >
            <RefreshCw className={cn("size-4", p.isRefreshing && "animate-spin")} aria-hidden />
          </button>
          )}
          {p.onMarkAllRead && (
            <button
              type="button"
              className={cn(iconBtn, "hidden wide:inline-flex")}
              onClick={p.onMarkAllRead}
              disabled={p.isMarkingAllRead}
              aria-label={tHeader("markAllAsRead")}
              title={tHeader("markAllAsRead")}
            >
              <CheckCheck className={cn("size-4", p.isMarkingAllRead && "animate-pulse")} aria-hidden />
            </button>
          )}
          {scope && (
          <button
            type="button"
            className={iconBtn}
            onClick={openMenu}
            aria-label={tHeader("moreOptions")}
            title={tHeader("moreOptions")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid="list-menu-button"
          >
            <MoreHorizontal className="size-5" aria-hidden />
          </button>
          )}
        </div>
      </div>
      {saved && scope && <LabelChips scope={scope} />}
      {search && isQuery && (
        <p className="px-(--gutter) pb-2 text-footnote tabular-nums text-muted-foreground" data-testid="search-summary">
          {p.resultSummary}
        </p>
      )}
      {p.active && scope && (
        <ResponsiveMenu
          open={menuOpen}
          onOpenChange={(open) => void (open ? nav.openOverlay("list-menu") : nav.closeOverlay("list-menu"))}
          mode={menu.mode}
          title={p.title}
          anchor={menu.anchor}
          items={items}
          testId="list-menu"
          returnFocus={() => headerRef.current?.querySelector<HTMLElement>('[data-testid="list-menu-button"]') ?? null}
        />
      )}
    </header>
  );
});

/** Gemerkt: Später | Favoriten (replace at the same depth; spec §1.4 row 6). */
function SavedSegments({ scope }: { scope: Scope }) {
  const t = useTranslations("listBar");
  return (
    <Segmented
      size="sm"
      label={t("savedViews")}
      testId="saved-segments"
      value={scope.kind}
      onChange={(kind) => void nav.goScope({ kind })}
      options={[
        { value: "later" as const, label: t("segmentLater") },
        { value: "starred" as const, label: t("segmentFavorites") },
      ]}
    />
  );
}

/** Gemerkt: the user's labels (scope `label`) as a chip row under the segments. */
function LabelChips({ scope }: { scope: Scope }) {
  const t = useTranslations("listBar");
  const { labels } = useShellData();
  if (!labels.length) return null;
  return (
    <div className="ff-label-chips" role="group" aria-label={t("labels")}>
      {labels.map((label: { id: string; name: string; color?: string | null }) => {
        const selected = scope.kind === "label" && scope.id === label.id;
        return (
          <Chip key={label.id} size="sm" aria-pressed={selected} onClick={() => void nav.goScope({ kind: "label", id: label.id })}>
            <span className="size-1.5 rounded-full" style={{ background: label.color ?? "var(--text-secondary)" }} aria-hidden />
            {label.name}
          </Chip>
        );
      })}
    </div>
  );
}
