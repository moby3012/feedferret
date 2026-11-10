"use client";

import { useEffect } from "react";
import { useArticleActions } from "@/features/articles/mutations";
import { getLayoutClass } from "@/features/reader/layout/layout-class";
import { canMarkAll, markViewScopeOf } from "@/features/reader/nav/sidebar-keys";
import { getNavState, nav } from "@/features/reader/nav/store";
import { clearSearch } from "./search-draft";
import type { ShellActions } from "./shell-context";

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * Any dialog, sheet, popover, menu or listbox is open (Radix / vaul mark theirs
 * `data-state="open"`), or a nav-store overlay is. It handles its own keys
 * (Escape included): no global shortcut may act on the list behind it.
 */
export function overlayOpen() {
  if (getNavState().overlay) return true;
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
  );
}

/**
 * Global keys (none while an overlay is open). Article moves (j/k/n/p) open the first article with a push and
 * then always REPLACE (`nav.openArticle` replaces while one is open), so
 * history never grows while reading. Esc: reader → clear search → nothing.
 * `/` → Suche tab (field focused) · `[` → collapse / expand the sidebar.
 */
export function useShellKeys(shell: ShellActions) {
  const { markViewRead } = useArticleActions();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      // Suspended while any overlay is open — j/k/n/p/r/s/l/m/o, Shift+A,
      // Shift+S, ?, /, [ and Escape all belong to the overlay then.
      if (overlayOpen()) return;
      const { loc } = getNavState();
      const articles = shell.activeList.get().articles;
      const current = loc.articleId;
      const at = current ? articles.findIndex((a) => a.id === current) : -1;
      const open = (a: (typeof articles)[number] | undefined) => {
        if (a) shell.selectArticle(a);
      };

      switch (e.key) {
        case "?":
          e.preventDefault();
          shell.setShortcutsOpen(true);
          return;
        case "/":
          e.preventDefault();
          shell.openSearch();
          return;
        case "[":
          // Expanded: sidebar ⇄ rail (persisted in the ff_ui cookie).
          if (getLayoutClass() !== "expanded") return;
          e.preventDefault();
          shell.toggleSourcesCollapsed();
          return;
        case "Escape":
          if (current) void nav.up();
          else if (loc.scope?.kind === "query") void clearSearch();
          return;
        case "j":
          return open(articles[at + 1]);
        case "k":
          return open(at > 0 ? articles[at - 1] : undefined);
        case "n":
          return open(articles.slice(at + 1).find((a) => !a.isRead));
        case "p":
          return open(at < 0 ? undefined : [...articles.slice(0, at)].reverse().find((a) => !a.isRead));
        case "r":
          return shell.refresh();
      }
      if (e.key === "A" && e.shiftKey) {
        e.preventDefault();
        if (loc.scope && canMarkAll(loc.scope)) markViewRead(markViewScopeOf(loc.scope));
        return;
      }
      if (e.key === "S" && e.shiftKey) {
        e.preventDefault();
        if (loc.scope?.kind === "query") shell.saveSearch(loc.scope.q);
        return;
      }
      if (!current) return;
      if (e.key === "s") shell.toggleStar(current);
      else if (e.key === "l") shell.toggleLater(current);
      else if (e.key === "m") shell.toggleRead(current);
      else if (e.key === "o") {
        const link = articles[at]?.link;
        if (link) window.open(link, "_blank", "noopener,noreferrer");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shell, markViewRead]);
}
