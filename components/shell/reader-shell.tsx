"use client";

import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ListPane } from "@/components/list/list-pane";
import { ReaderPane } from "@/components/reader/reader-pane";
import { useCounts, useScopeUnread } from "@/features/bootstrap/queries";
import { useLayoutClass } from "@/features/reader/layout/layout-class";
import type { UiPrefs } from "@/features/reader/layout/ui-prefs";
import { TAB_IDS } from "@/features/reader/nav/location";
import { NavProvider, bootNav, useNav } from "@/features/reader/nav/store";
import { useAppBadge } from "@/hooks/use-app-badge";
import { markInAppNavigation } from "@/lib/in-app-back";
import { BottomBar } from "./bottom-bar";
import { PaneResizer } from "./pane-resizer";
import { ShellOverlays } from "./shell-overlays";
import { ShellProvider, useShellActions, useShellData, type ShellActions } from "./shell-context";
import { useSearchCommit } from "./search-draft";
import { SourcesPane } from "./sources-pane";
import { useShellKeys } from "./use-shell-keys";

interface ReaderShellProps {
  /** Request URL (`/?…`) — the nav store's server snapshot, so SSR and hydration agree. */
  initialHref: string;
  initialUi: UiPrefs;
}

/**
 * The reader app: one flat tree for every form factor. CSS (app/styles/
 * shell.css) places the panes from the root's data attributes; nothing here
 * branches on the viewport before mount, so there is no layout spinner.
 */
export function ReaderShell({ initialHref, initialUi }: ReaderShellProps) {
  return (
    <NavProvider initialHref={initialHref}>
      <ShellProvider>
        <ShellRoot initialUi={initialUi} />
      </ShellProvider>
    </NavProvider>
  );
}

function ShellRoot({ initialUi }: { initialUi: UiPrefs }) {
  const tab = useNav((s) => s.loc.tab);
  const hasScope = useNav((s) => !!s.loc.scope);
  const readerOpen = useNav((s) => !!s.loc.articleId);
  // Compact reader covers the bottom controls: out of focus order / a11y tree.
  const bottomCovered = useLayoutClass() === "compact" && readerOpen;
  const shell = useShellActions();
  useShellKeys(shell);
  useSearchCommit();
  useBoot(shell);
  useBackgroundWork();

  const style = useMemo(
    () => (initialUi.listW ? ({ "--list-w": `${initialUi.listW}px` } as CSSProperties) : undefined),
    [initialUi.listW],
  );

  return (
    <div
      id="main-content"
      role="main"
      className="ff-shell app-chrome selection:bg-accent/20"
      data-tab={tab}
      data-scope={hasScope ? "1" : "0"}
      data-reader={readerOpen ? "open" : "closed"}
      style={style}
    >
      <LiveRegion />
      <SourcesPane />
      {TAB_IDS.map((id) => (
        <ListPane key={id} tab={id} />
      ))}
      <ReaderPane />
      <PaneResizer initialWidth={initialUi.listW} />
      <div className="ff-shell-bottom" inert={bottomCovered || undefined} aria-hidden={bottomCovered || undefined}>
        <BottomBar />
      </div>
      <ShellOverlays />
    </div>
  );
}

/** URL boot (aliases, stack seeding, popstate) + one-shot intents + legacy window events. */
function useBoot(shell: ShellActions) {
  useEffect(() => {
    markInAppNavigation();
    const stop = bootNav((intents) => shell.requestAddFeed(intents.sharedUrl ?? undefined));
    // Sidebar search icon (until SourcesView, PR 7).
    const onFocusSearch = () => shell.openSearch();
    window.addEventListener("focus-search", onFocusSearch);
    return () => {
      stop();
      window.removeEventListener("focus-search", onFocusSearch);
    };
  }, [shell]);
}

/** Lazy sync on load + app badge. */
function useBackgroundWork() {
  const t = useTranslations("sidebar");
  const counts = useCounts(true);
  const unreadBadge = useMemo(() => Object.values(counts.byFeed).reduce((sum, n) => sum + n, 0), [counts.byFeed]);
  useAppBadge(unreadBadge, true);

  const toastShown = useRef(false);
  useEffect(() => {
    fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" } })
      .then((res) => {
        if (!res.ok) throw new Error(`Sync request failed (${res.status})`);
        localStorage.setItem("lastSync", new Date().toISOString());
      })
      .catch(() => {
        if (toastShown.current) return;
        toastShown.current = true;
        toast.error(t("syncFailedToast"));
      });
  }, [t]);
}

/** Announces the unread count of the bound scope (spec §4.9.8: on scope change, not per mark-read). */
function LiveRegion() {
  const scope = useNav((s) => s.loc.scope);
  const { feeds } = useShellData();
  const unread = useScopeUnread(scope, feeds, true);
  const scopeId = useNav((s) => (s.loc.scope ? JSON.stringify(s.loc.scope) : ""));
  const announced = useRef<{ scopeId: string; text: string }>({ scopeId: "", text: "" });
  if (unread !== undefined && announced.current.scopeId !== scopeId) {
    announced.current = { scopeId, text: `${unread} unread ${unread === 1 ? "article" : "articles"}` };
  }
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {announced.current.text}
    </div>
  );
}
