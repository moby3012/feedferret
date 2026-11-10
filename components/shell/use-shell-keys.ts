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

/** A Radix dialog / sheet / menu handles its own Escape. */
function overlayOpen() {
  return !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]');
}

/**
 * Global keys. Article moves (j/k/n/p) open the first article with a push and
 * then always REPLACE (`nav.openArticle` replaces while one is open), so
 * history never grows while reading. Esc: reader → clear search → nothing.
 * `/` → Suche tab (field focused) · `[` → collapse / expand the sidebar.
 */
export function useShellKeys(shell: ShellActions) {
  const { markViewRead } = useArticleActions();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
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
          if (getLayoutClass() !== "expanded" || overlayOpen()) return;
          e.preventDefault();
          shell.toggleSourcesCollapsed();
          return;
        case "Escape":
          if (overlayOpen()) return;
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
