"use client";

import { useCallback, useMemo, useState, memo } from "react";
import { useTranslations } from "next-intl";
import { Search as SearchIcon, X as XIcon } from "lucide-react";
import { AddFeedDialog } from "@/components/add-feed-dialog";
import { CommandPalette } from "@/components/command-palette";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useArticleList } from "@/features/articles/queries";
import { listKeyOf } from "@/features/articles/scope";
import { useArticleActions } from "@/features/articles/mutations";
import { useDebounce } from "@/hooks/use-debounce";
import { canMarkAll, categoryKey, markViewScopeOf, scopeFromSidebarKey } from "@/features/reader/nav/sidebar-keys";
import type { OverlayId } from "@/features/reader/nav/overlays";
import { nav, useNav } from "@/features/reader/nav/store";
import { useShellActions, useShellData } from "./shell-context";
import { commitSearch, committedQuery } from "./search-draft";
import { SourcesSheet } from "./sources-pane";

/** open/onOpenChange of one nav-store overlay (system Back closes it; opening another swaps it). */
function useOverlay(id: OverlayId): [boolean, (open: boolean) => Promise<void>] {
  const open = useNav((s) => s.overlay === id);
  const onOpenChange = useCallback((next: boolean) => (next ? nav.openOverlay(id) : nav.closeOverlay(id)), [id]);
  return [open, onOpenChange];
}

const togglePalette = () => void nav.toggleOverlay("palette");

/** Every shell overlay. Open state lives in the nav store (`history.state.ff` on touch / compact). */
export const ShellOverlays = memo(function ShellOverlays() {
  const { feeds, categories, labels, addFeed } = useShellData();
  const shell = useShellActions();
  const { markViewRead } = useArticleActions();
  const scope = useNav((s) => s.loc.scope);
  const [shortcutsOpen, setShortcutsOpen] = useOverlay("shortcuts");
  const [paletteOpen, setPaletteOpen] = useOverlay("palette");
  const [addFeedOpen, setAddFeedOpen] = useOverlay("add-feed");
  const subscribedUrls = useMemo(() => new Set<string>(feeds.map((f: any) => f.url).filter(Boolean)), [feeds]);
  // Mounted on first use only: its connector-status queries stay off the cold-start path.
  const [addFeedUsed, setAddFeedUsed] = useState(false);
  if (addFeedOpen && !addFeedUsed) setAddFeedUsed(true);
  return (
    <>
      <SourcesSheet />
      <SearchDialog />
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {addFeedUsed && (
        <AddFeedDialog open={addFeedOpen} onOpenChange={setAddFeedOpen} subscribedUrls={subscribedUrls} initialUrl={addFeed.url} requestId={addFeed.n} />
      )}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onToggle={togglePalette}
        feeds={feeds}
        categories={categories}
        labels={labels}
        onRefresh={shell.refresh}
        onMarkAllRead={scope && canMarkAll(scope) ? () => markViewRead(markViewScopeOf(scope)) : undefined}
        onFocusSearch={shell.openSearch}
        onAddFeed={() => shell.requestAddFeed()}
        onOpenSettings={shell.openSettings}
        onShowShortcuts={() => shell.setShortcutsOpen(true)}
        onSelectFeed={(id) => void nav.goScope({ kind: "feed", id })}
        onSelectCategory={(id) => void nav.goScope(scopeFromSidebarKey(categoryKey(id)))}
        onSelectLabel={(id) => void nav.goScope({ kind: "label", id })}
      />
    </>
  );
});

/** Search dialog: edits the draft, previews the match count, commits on submit (replace `?q=`). */
function SearchDialog() {
  const t = useTranslations("sidebar");
  const tA11y = useTranslations("accessibility");
  const tSearch = useTranslations("searchResults");
  const open = useNav((s) => s.overlay === "search");
  // The dialog's own draft (not the inline one): seeded from `?q=` on every
  // open, discarded on every dismissal — only submit commits it.
  const [draft, setDraft] = useState("");
  const [seededFor, setSeededFor] = useState(false);
  if (open !== seededFor) {
    setSeededFor(open);
    setDraft(open ? committedQuery() : "");
  }
  const debounced = useDebounce(draft, 300).trim();
  // Same list (and cache entry) the search pane binds after the commit.
  const previewKey = useMemo(() => (open && debounced ? listKeyOf({ kind: "query", q: debounced }, "all", "new") : null), [open, debounced]);
  const preview = useArticleList(previewKey, { active: !!previewKey });
  const count = preview.items.length;
  const unread = preview.items.filter((a) => !a.isRead).length;

  const close = () => void nav.closeOverlay("search");

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? void nav.openOverlay("search") : close())}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-xl rounded-2xl border-border/60 bg-card/95 backdrop-blur-bar shadow-overlay p-0 gap-0 overflow-hidden"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("searchArticles")}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            // Keys typed while the dialog animates out must not land in its input.
            (document.activeElement as HTMLElement | null)?.blur();
            void commitSearch(draft);
          }}
        >
          <div className="flex items-center gap-3 px-5 pt-5 pb-3 border-b border-border/50">
            <SearchIcon className="w-5 h-5 text-muted-foreground shrink-0" />
            <Input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={tSearch("searchPlaceholder")}
              className="border-0 bg-transparent text-base sm:text-lg font-medium focus-visible:ring-0 focus-visible:ring-offset-0 px-2 h-12 py-0 placeholder:text-muted-foreground/70"
              autoFocus
              enterKeyHint="search"
            />
            <button
              type="button"
              onClick={() => (draft ? setDraft("") : close())}
              aria-label={draft ? tA11y("clearSearch") : tA11y("closeSearch")}
              className="flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
            >
              <XIcon className="w-5 h-5" />
            </button>
          </div>
          <div className="px-5 py-3 text-xs text-muted-foreground">
            {draft.trim()
              ? `${tSearch("matchesAcrossFeeds", { count })} (${tSearch("unreadCount", { count: unread })})`
              : tSearch("globalSearchHint")}
          </div>
          <div className="flex flex-col gap-2 px-4 pb-4 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={close}
              className="order-2 sm:order-1 rounded-xl border border-border/60 bg-background/60 px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {tSearch("cancel")}
            </button>
            <button
              type="submit"
              disabled={!draft.trim()}
              className="order-1 sm:order-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm active:scale-[0.98] transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {draft.trim() ? tSearch("showResults", { count }) : tSearch("enterSearchTerm")}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
