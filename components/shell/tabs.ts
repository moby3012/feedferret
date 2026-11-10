"use client";

import { Bookmark, Inbox, Rss, Search, type LucideIcon } from "lucide-react";
import { getLayoutClass, type LayoutClass } from "@/features/reader/layout/layout-class";
import type { TabId } from "@/features/reader/nav/location";
import { getNavState, nav } from "@/features/reader/nav/store";

// The four destinations (spec §4.6): compact tab bar and medium / collapsed
// rail share the definitions and the tap semantics.

export interface TabDef {
  id: TabId;
  icon: LucideIcon;
  /** `tabs` namespace key of the label. */
  label: "new" | "saved" | "feeds" | "search";
}

export const TABS: readonly TabDef[] = [
  { id: "new", icon: Inbox, label: "new" },
  { id: "saved", icon: Bookmark, label: "saved" },
  { id: "feeds", icon: Rss, label: "feeds" },
  { id: "search", icon: Search, label: "search" },
];

/**
 * The tab element that labels a tab's panel (aria-labelledby), or `null` when no
 * tablist is shown (expanded layout with the full sidebar): the compact tab bar,
 * else the rail. Both tablists are static markup; the layout decides which one is visible.
 */
export function tabLabelIdOf(tab: TabId, layout: LayoutClass | null, sourcesCollapsed: boolean): string | null {
  if (layout === "compact") return `ff-tab-${tab}`;
  if (layout === "medium" || (layout === "expanded" && sourcesCollapsed)) return `ff-rail-tab-${tab}`;
  return null;
}

/** DOM ids the tabs control (aria-controls). */
export function paneIdsOf(tab: TabId): string {
  return tab === "feeds" ? "ff-pane-sources ff-pane-feeds" : `ff-pane-${tab}`;
}

// ---------------------------------------------------------------- search focus
// Focus is taken only on a user action that lands on an empty Suche tab
// (spec §4.6) — never on restore. The field picks the request up when it is
// (or becomes) the active one.
let searchFocusPending = false;
const SEARCH_FOCUS_EVENT = "ff:search-focus";

export function requestSearchFocus() {
  searchFocusPending = true;
  window.dispatchEvent(new Event(SEARCH_FOCUS_EVENT));
}

/** Consumes a pending focus request (the active search field calls this). */
export function takeSearchFocus(): boolean {
  const pending = searchFocusPending;
  searchFocusPending = false;
  return pending;
}

export function onSearchFocusRequest(listener: () => void): () => void {
  window.addEventListener(SEARCH_FOCUS_EVENT, listener);
  return () => window.removeEventListener(SEARCH_FOCUS_EVENT, listener);
}

/** The sources show as the icon rail (medium, or expanded with the sidebar collapsed): the tree opens as a drawer. */
export function sourcesAreRail(): boolean {
  const layout = getLayoutClass();
  return layout === "medium" || (layout === "expanded" && !!document.querySelector('.ff-shell[data-sources="rail"]'));
}

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Scrolls the visible list (or the Feeds root) of a tab to the top. */
export function scrollTabToTop(tab: TabId) {
  const { loc } = getNavState();
  const root =
    tab === "feeds" && !loc.scope
      ? document.querySelector<HTMLElement>('[data-pane="sources"] .ff-feeds-scroller, [data-pane="sources"] [data-radix-scroll-area-viewport]')
      : document.querySelector<HTMLElement>(`[data-pane="list-${tab}"] [data-testid="list-scroller"]`);
  root?.scrollTo({ top: 0, behavior: reducedMotion() ? "instant" : "smooth" });
}

/**
 * Tab tap (spec §1.4): another tab → its remembered stack (`resetStack`);
 * the active tab → one level up when a level is pushed, else scroll to top.
 * Suche: an empty search tab focuses its field.
 */
export function activateTab(tab: TabId): Promise<void> {
  const s = getNavState();
  if (s.loc.tab !== tab) {
    return nav.goTab(tab).then(() => {
      const now = getNavState().loc;
      if (tab === "search" && !now.scope) requestSearchFocus();
      // Wide: the Feeds tab without a feed shows the sources (drawer on medium / collapsed rail).
      if (tab === "feeds" && !now.scope && sourcesAreRail()) void nav.openOverlay("sources");
    });
  }
  if (s.overlay) return nav.closeOverlay();
  if (s.index > 0) return nav.up();
  if (tab === "search" && !s.loc.scope) requestSearchFocus();
  else scrollTabToTop(tab);
  return Promise.resolve();
}

/** Roving focus inside a tablist (←/→ or ↑/↓, Home, End). */
export function onTablistKeyDown(e: React.KeyboardEvent<HTMLElement>, orientation: "horizontal" | "vertical") {
  const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  const prev = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  if (![next, prev, "Home", "End"].includes(e.key)) return;
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at === -1) return;
  e.preventDefault();
  const rtl = orientation === "horizontal" && getComputedStyle(e.currentTarget).direction === "rtl";
  let to = at;
  if (e.key === "Home") to = 0;
  else if (e.key === "End") to = tabs.length - 1;
  else if ((e.key === next) !== rtl) to = (at + 1) % tabs.length;
  else to = (at - 1 + tabs.length) % tabs.length;
  tabs[to].focus();
}
