"use client";

import { useCallback, useEffect, useMemo, useState, memo } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useArticleActions } from "@/features/articles/mutations";
import { canMarkAll, categoryKey, scopeFromSidebarKey } from "@/features/reader/nav/sidebar-keys";
import type { OverlayId } from "@/features/reader/nav/overlays";
import { nav, useNav } from "@/features/reader/nav/store";
import { useShellActions, useShellData } from "./shell-context";
import { SourcesSheet } from "./sources-pane";

/** open/onOpenChange of one nav-store overlay (system Back closes it; opening another swaps it). */
function useOverlay(id: OverlayId): [boolean, (open: boolean) => Promise<void>] {
  const open = useNav((s) => s.overlay === id);
  const onOpenChange = useCallback((next: boolean) => (next ? nav.openOverlay(id) : nav.closeOverlay(id)), [id]);
  return [open, onOpenChange];
}

// Rarely opened overlays are their own chunks, loaded (and mounted) on first use.
const AddFeedDialog = dynamic(() => import("@/components/add-feed-dialog").then((m) => m.AddFeedDialog), { ssr: false });
export const loadCommandPalette = () => import("@/components/command-palette");
export const loadShortcutsDialog = () => import("@/components/keyboard-shortcuts-dialog");
const CommandPalette = dynamic(() => loadCommandPalette().then((m) => m.CommandPalette), { ssr: false });
const KeyboardShortcutsDialog = dynamic(() => loadShortcutsDialog().then((m) => m.KeyboardShortcutsDialog), { ssr: false });

const togglePalette = () => void nav.toggleOverlay("palette");

/**
 * Global ⌘K / Ctrl-K: open the palette, or close it when open. Deliberately
 * fires regardless of focus (including inside inputs) — the convention of most
 * command palettes; the app's single-key shortcuts bail out whenever a
 * modifier key is held. Lives here (not in the lazily loaded palette) so the
 * very first ⌘K works before the palette's chunk exists.
 */
function usePaletteHotkey() {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        togglePalette();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}

/** Mounted from the first time `open` is true on (keeps its close transition afterwards). */
function useUsed(open: boolean): boolean {
  const [used, setUsed] = useState(open);
  if (open && !used) setUsed(true);
  return used;
}

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
  usePaletteHotkey();
  // Mounted on first use only: their chunks (and the Add Feed connector-status
  // queries) stay off the cold-start path.
  const addFeedUsed = useUsed(addFeedOpen);
  const shortcutsUsed = useUsed(shortcutsOpen);
  const paletteUsed = useUsed(paletteOpen);
  return (
    <>
      <SourcesSheet />
      <SaveSearchDialog />
      {shortcutsUsed && <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />}
      {addFeedUsed && (
        <AddFeedDialog open={addFeedOpen} onOpenChange={setAddFeedOpen} subscribedUrls={subscribedUrls} initialUrl={addFeed.url} initialTab={addFeed.tab} requestId={addFeed.n} />
      )}
      {paletteUsed && (
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          feeds={feeds}
          categories={categories}
          labels={labels}
          onRefresh={shell.refresh}
          onMarkAllRead={scope && canMarkAll(scope) ? () => markViewRead(scope) : undefined}
          onFocusSearch={shell.openSearch}
          onAddFeed={() => shell.requestAddFeed()}
          onOpenSettings={shell.openSettings}
          onShowShortcuts={() => shell.setShortcutsOpen(true)}
          onSelectFeed={(id) => void nav.goScope({ kind: "feed", id })}
          onSelectCategory={(id) => void nav.goScope(scopeFromSidebarKey(categoryKey(id)))}
          onSelectLabel={(id) => void nav.goScope({ kind: "label", id })}
        />
      )}
    </>
  );
});

/** Names the committed query and saves it (replaces window.prompt; spec §3 shell-overlays). */
function SaveSearchDialog() {
  const t = useTranslations("saveSearch");
  const tSearch = useTranslations("searchResults");
  const { saveSearchQuery } = useShellData();
  const shell = useShellActions();
  const [open, setOpen] = useOverlay("save-search");
  const [name, setName] = useState("");
  const [seededFor, setSeededFor] = useState(false);
  if (open !== seededFor) {
    setSeededFor(open);
    if (open) setName(saveSearchQuery.length > 40 ? `${saveSearchQuery.slice(0, 40)}…` : saveSearchQuery);
  }
  return (
    <Dialog open={open} onOpenChange={(next) => void setOpen(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription className="truncate">{saveSearchQuery}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            shell.createSavedSearch(name, saveSearchQuery);
            void setOpen(false);
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={t("name")} placeholder={t("name")} className="h-11 text-body" autoFocus />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => void setOpen(false)}>
              {tSearch("cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
