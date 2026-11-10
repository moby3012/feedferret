"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, memo } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { PanelLeftClose, Plus, Settings } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useCounts } from "@/features/bootstrap/queries";
import { parseCountDisplay } from "@/lib/count-display";
import { useLayoutClass } from "@/features/reader/layout/layout-class";
import { scopeFromSidebarKey, sidebarSelectionOf } from "@/features/reader/nav/sidebar-keys";
import { nav, useNav } from "@/features/reader/nav/store";
import { ShellRail } from "./shell-rail";
import { tabLabelIdOf } from "./tabs";
import { useShellActions, useShellData, useSourcesCollapsed } from "./shell-context";

// Feeds navigation (the pre-shell RssSidebar tree, reused) in its hosts:
//   · `SourcesPane` — the sources column: the full tree on expanded and as the
//     compact Feeds root (Feeds tab), the 72 px icon rail on medium and on
//     expanded with the sidebar collapsed (`[`);
//   · `SourcesSheet` — the tree as a left drawer from the rail.
// Selection goes through the nav store. The compact feed sheet is gone: the
// Feeds tab is the feed picker.

// The sidebar (with dnd-kit reordering) only ever mounts after hydration —
// expanded column, compact Feeds root, sheet / drawer — so it is a chunk of
// its own instead of part of the cold-start bundle.
// Exported so the offline layer can warm the very same chunk (a bare import() resolves to a different chunk group).
export const loadRssSidebar = () => import("@/components/rss-sidebar");
const RssSidebar = dynamic(() => loadRssSidebar().then((m) => m.RssSidebar), { ssr: false });

function useSidebarProps() {
  const t = useTranslations("sidebar");
  const { feeds, prefs } = useShellData();
  const shell = useShellActions();
  const counts = useCounts(true);
  const scope = useNav((s) => s.loc.scope);
  const sidebarFeeds = useMemo(
    () =>
      feeds.map((f: any) => ({
        ...f,
        category: f.category?.name || t("uncategorized"),
        categoryHideFromAllFeeds: f.category?.hideFromAllFeeds ?? false,
        unreadCount: counts.byFeed[f.id] ?? 0,
        icon: f.icon || "📰",
      })),
    [feeds, counts.byFeed, t],
  );
  const { selectedFeed, selectedCategory } = sidebarSelectionOf(scope);
  return {
    feeds: sidebarFeeds,
    selectedFeed,
    selectedCategory,
    onAddFeed: () => shell.requestAddFeed(),
    hideEmptyFeeds: prefs?.hideEmptyFeeds ?? false,
    hideEmptyLabels: prefs?.hideEmptyLabels ?? false,
    countDisplay: parseCountDisplay(prefs?.countDisplay),
    onOpenArticle: (id: string) => void nav.openArticle(id),
  };
}

const selectFeed = (feedId: string | null) => {
  if (feedId) void nav.goScope({ kind: "feed", id: feedId });
};
const selectCategory = (key: string) => void nav.goScope(scopeFromSidebarKey(key));

/**
 * Sources column. The rail is static markup (CSS shows it on medium / the
 * collapsed expanded layout). The tree mounts after hydration (post-mount
 * widget: the grid column is CSS, so nothing shifts) and only where it is
 * shown: the expanded sidebar, and the compact Feeds root once opened.
 */
export const SourcesPane = memo(function SourcesPane() {
  const layout = useLayoutClass();
  const sourcesCollapsed = useSourcesCollapsed();
  const atFeedsRoot = useNav((s) => s.loc.tab === "feeds" && !s.loc.scope);
  const [visitedRoot, setVisitedRoot] = useState(false);
  if (atFeedsRoot && layout === "compact" && !visitedRoot) setVisitedRoot(true);
  const mounted = (layout === "expanded" && !sourcesCollapsed) || (layout === "compact" && (visitedRoot || atFeedsRoot));
  // Covered on compact by a pushed feed list or the reader (also over the Feeds root).
  const readerOpen = useNav((s) => !!s.loc.articleId);
  const inert = layout === "compact" && (!atFeedsRoot || readerOpen);
  return (
    <div data-pane="sources" inert={inert || undefined} aria-hidden={inert || undefined} className="overflow-hidden">
      <ShellRail />
      {/* Compact: the Feeds root — the Feeds tab's panel (the rail above is not part of it). */}
      <div
        id="ff-pane-sources"
        className="ff-sources-full"
        role={layout === "compact" ? "tabpanel" : undefined}
        aria-labelledby={layout === "compact" ? tabLabelIdOf("feeds", layout, sourcesCollapsed) ?? undefined : undefined}
      >
        <FeedsHeader />
        {mounted && <SourcesHost />}
      </div>
    </div>
  );
});

/** Compact Feeds root: large title + add feed + settings (spec §4.6). */
function FeedsHeader() {
  const t = useTranslations("tabs");
  const tSidebar = useTranslations("sidebar");
  const shell = useShellActions();
  const btn = "hit-slop inline-flex size-11 items-center justify-center rounded-control text-muted-foreground active:bg-surface-sunken";
  return (
    <header className="ff-feeds-header items-center gap-1 ps-(--gutter) pe-2 pt-[max(var(--safe-t),8px)] pb-1">
      <h2 className="min-w-0 flex-1 truncate text-headline text-foreground">{t("feeds")}</h2>
      <button type="button" className={btn} onClick={() => shell.requestAddFeed()} aria-label={tSidebar("addFeed")} title={tSidebar("addFeed")}>
        <Plus className="size-5" aria-hidden />
      </button>
      <button type="button" className={btn} onClick={shell.openSettings} aria-label={t("settings")} title={t("settings")}>
        <Settings className="size-5" aria-hidden />
      </button>
    </header>
  );
}

/** Expanded sidebar: collapse to the rail (`[`). */
function CollapseButton() {
  const t = useTranslations("tabs");
  const shell = useShellActions();
  return (
    <button
      type="button"
      className="hidden size-8 shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-surface-sunken hover:text-foreground expanded:inline-flex"
      onClick={shell.toggleSourcesCollapsed}
      aria-label={t("collapseSidebar")}
      title={`${t("collapseSidebar")} ([)`}
    >
      <PanelLeftClose className="size-4" aria-hidden />
    </button>
  );
}

function SourcesHost({ inDrawer = false }: { inDrawer?: boolean }) {
  const props = useSidebarProps();
  return <RssSidebar {...props} onSelectFeed={selectFeed} onSelectCategory={selectCategory} headerAction={inDrawer ? undefined : <CollapseButton />} />;
}

/** The tree as a left drawer from the rail (medium, collapsed expanded). Open state = nav overlay "sources". */
export function SourcesSheet() {
  const t = useTranslations("sidebar");
  const open = useNav((s) => s.overlay === "sources");
  const layout = useLayoutClass();
  const sourcesCollapsed = useSourcesCollapsed();
  const onOpenChange = useCallback((next: boolean) => {
    if (next) void nav.openOverlay("sources");
    else void nav.closeOverlay("sources");
  }, []);
  // Focus returns to the rail control that opened the drawer ("show sources" or the
  // Feeds tab). Captured in a layout effect — before Radix moves focus into the
  // drawer — because the drawer also opens and closes through history (Back, a
  // picked feed re-rendering the rail), where Radix's own restore can land on <body>.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active.closest(".ff-rail") ? active : null;
  }, [open]);
  const onCloseAutoFocus = useCallback((e: Event) => {
    const target =
      (opener.current?.isConnected ? opener.current : null) ??
      document.querySelector<HTMLElement>('.ff-rail [role="tab"][aria-selected="true"]');
    opener.current = null;
    if (!target || target.getClientRects().length === 0) return; // rail hidden (layout changed): Radix default
    e.preventDefault();
    target.focus({ preventScroll: true });
  }, []);
  if (layout === "compact" || layout === null || (layout === "expanded" && !sourcesCollapsed)) return null;
  return (
    // A Radix Sheet (not vaul): the sidebar hosts Radix dialogs (delete /
    // sign-out confirms) that portal to <body>; nested inside vaul they lose
    // text focus on iOS. Add Feed is a shell overlay of its own (never nested).
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-(--sidebar-w) max-w-[86vw] p-0 pt-12 gap-0" onCloseAutoFocus={onCloseAutoFocus}>
        <SheetTitle className="sr-only">{t("feedNavigation")}</SheetTitle>
        {open && <SourcesHost inDrawer />}
      </SheetContent>
    </Sheet>
  );
}
