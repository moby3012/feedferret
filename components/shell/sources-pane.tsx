"use client";

import { useCallback, useMemo, useState, memo } from "react";
import { useTranslations } from "next-intl";
import { RssSidebar } from "@/components/rss-sidebar";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useCounts } from "@/features/bootstrap/queries";
import { useLayoutClass } from "@/features/reader/layout/layout-class";
import { scopeFromSidebarKey, sidebarSelectionOf } from "@/features/reader/nav/sidebar-keys";
import { nav, useNav } from "@/features/reader/nav/store";
import { useShellData, type AddFeedHost } from "./shell-context";

// Feeds navigation (the pre-shell RssSidebar, reused) in its two hosts until
// SourcesView lands (PR 7): the sources column on expanded / the Feeds root on
// compact (`SourcesPane`), and a drawer on medium + the compact feed sheet
// (`SourcesSheet`). Selection goes through the nav store.

function useSidebarProps(host: AddFeedHost) {
  const t = useTranslations("sidebar");
  const { feeds, prefs, addFeed } = useShellData();
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
    defaultOpenAddFeed: addFeed.host === host ? addFeed.n : 0,
    initialWebpageUrl: addFeed.host === host ? addFeed.url : undefined,
    hideEmptyFeeds: prefs?.hideEmptyFeeds ?? false,
    hideEmptyLabels: prefs?.hideEmptyLabels ?? false,
    onOpenArticle: (id: string) => void nav.openArticle(id),
  };
}

const selectFeed = (feedId: string | null) => {
  if (feedId) void nav.goScope({ kind: "feed", id: feedId });
};
const selectCategory = (key: string) => void nav.goScope(scopeFromSidebarKey(key));

/**
 * Sources column (expanded) / Feeds root (compact). Mounts after hydration
 * (post-mount widget: the grid column is CSS, so nothing shifts) and only
 * where it is shown: never on medium, on compact once the Feeds root opened.
 */
export const SourcesPane = memo(function SourcesPane() {
  const layout = useLayoutClass();
  const atFeedsRoot = useNav((s) => s.loc.tab === "feeds" && !s.loc.scope);
  const [visitedRoot, setVisitedRoot] = useState(false);
  if (atFeedsRoot && layout === "compact" && !visitedRoot) setVisitedRoot(true);
  const mounted = layout === "expanded" || (layout === "compact" && (visitedRoot || atFeedsRoot));
  const inert = layout === "compact" && !atFeedsRoot;
  return (
    <div data-pane="sources" inert={inert || undefined} aria-hidden={inert || undefined} className="overflow-hidden">
      {mounted && <SourcesHost host="inline" />}
    </div>
  );
});

function SourcesHost({ host }: { host: AddFeedHost }) {
  const props = useSidebarProps(host);
  return <RssSidebar {...props} onSelectFeed={selectFeed} onSelectCategory={selectCategory} />;
}

/** Feed sheet (compact, from the bottom controls) / left drawer (medium). Open state = nav overlay "sources". */
export function SourcesSheet() {
  const t = useTranslations("sidebar");
  const open = useNav((s) => s.overlay === "sources");
  const layout = useLayoutClass();
  const onOpenChange = useCallback((next: boolean) => {
    if (next) void nav.openOverlay("sources");
    else void nav.closeOverlay();
  }, []);
  if (layout === "expanded") return null;
  const side = layout === "medium" ? "left" : "bottom";
  return (
    // A Radix Sheet (not vaul): the sidebar hosts Radix dialogs (Add feed)
    // that portal to <body>; nested inside vaul they lose text focus on iOS.
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className={side === "bottom" ? "h-[86dvh] rounded-t-sheet border-border/70 p-0 pt-12 gap-0" : "w-(--sidebar-w) max-w-[86vw] p-0 pt-12 gap-0"}
      >
        <SheetTitle className="sr-only">{t("feedNavigation")}</SheetTitle>
        {open && <SourcesHost host="sheet" />}
      </SheetContent>
    </Sheet>
  );
}
