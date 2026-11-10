"use client";

import { MobileBottomControls } from "@/components/mobile-bottom-controls";
import { useArticleActions, useIsMarkingViewRead } from "@/features/articles/mutations";
import { canMarkAll, markViewScopeOf } from "@/features/reader/nav/sidebar-keys";
import { nav, useNav } from "@/features/reader/nav/store";
import { useShellActions, useShellData } from "./shell-context";
import { clearSearch, useSearchDraft } from "./search-draft";

/**
 * Compact list controls (today's bottom bar, kept until the tab bar in PR 7).
 * Hidden on wide (CSS) and on the Feeds root; the reader covers it.
 */
export function BottomBar() {
  const scope = useNav((s) => s.loc.scope);
  const show = useNav((s) => s.loc.show);
  const sourcesOpen = useNav((s) => s.overlay === "sources");
  const { isRefreshing } = useShellData();
  const shell = useShellActions();
  const { markViewRead } = useArticleActions();
  const isMarkingAllRead = useIsMarkingViewRead();
  const [draft, setDraft] = useSearchDraft();
  if (!scope) return null; // Feeds root: the sources list is the screen
  const isSearchActive = scope.kind === "query";
  return (
    <MobileBottomControls
      unreadOnly={show === "unread"}
      onToggleUnreadOnly={() => void nav.setShow(show === "unread" ? "all" : "unread")}
      onToggleSidebar={shell.openSources}
      sidebarOpen={sourcesOpen}
      onRefresh={shell.refresh}
      isRefreshing={isRefreshing}
      searchQuery={draft}
      onSearchChange={setDraft}
      onMarkAllRead={canMarkAll(scope) ? () => markViewRead(markViewScopeOf(scope)) : undefined}
      isMarkingAllRead={isMarkingAllRead}
      isSearchActive={isSearchActive}
      onCloseSearch={() => void clearSearch()}
      onEditSearch={shell.openSearch}
    />
  );
}
