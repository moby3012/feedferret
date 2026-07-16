"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import {
  RefreshCw,
  CheckCheck,
  Search,
  Plus,
  Settings,
  SunMoon,
  Keyboard,
  Rss,
  FolderOpen,
  Tag,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";

interface CommandPaletteFeed {
  id: string;
  name: string;
}

interface CommandPaletteCategory {
  id: string;
  name: string;
}

interface CommandPaletteLabel {
  id: string;
  name: string;
  color?: string;
}

interface CommandPaletteProps {
  feeds: CommandPaletteFeed[];
  categories: CommandPaletteCategory[];
  labels: CommandPaletteLabel[];
  onRefresh: () => void;
  onMarkAllRead: () => void;
  onFocusSearch: () => void;
  onAddFeed: () => void;
  onOpenSettings: () => void;
  onShowShortcuts: () => void;
  onSelectFeed: (feedId: string) => void;
  onSelectCategory: (categoryName: string) => void;
  onSelectLabel: (labelId: string) => void;
}

// This component is intentionally "dumb": it renders lists and wires
// selection to the handlers/data passed in from app/page.tsx, which owns
// all the actual business logic (feed/category/label selection, refresh,
// mark-all-read, etc). No state beyond open/closed lives here.
export function CommandPalette({
  feeds,
  categories,
  labels,
  onRefresh,
  onMarkAllRead,
  onFocusSearch,
  onAddFeed,
  onOpenSettings,
  onShowShortcuts,
  onSelectFeed,
  onSelectCategory,
  onSelectLabel,
}: CommandPaletteProps) {
  const t = useTranslations("commandPalette");
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);

  // Global ⌘K / Ctrl-K listener. Deliberately fires regardless of focus
  // (including inside inputs) — this mirrors the convention used by most
  // command palettes and doesn't collide with the app's single-key
  // shortcuts, which already bail out whenever a modifier key is held
  // (see handleKeyDown in app/page.tsx).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const runAction = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  const toggleTheme = () => {
    if (theme === "dark") setTheme("system");
    else if (theme === "system") setTheme("light");
    else setTheme("dark");
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={t("title")}
      description={t("description")}
    >
      <CommandInput placeholder={t("placeholder")} />
      <CommandList>
        <CommandEmpty>{t("empty")}</CommandEmpty>

        <CommandGroup heading={t("groups.actions")}>
          <CommandItem value={t("actions.refresh")} onSelect={() => runAction(onRefresh)}>
            <RefreshCw />
            {t("actions.refresh")}
            <CommandShortcut>R</CommandShortcut>
          </CommandItem>
          <CommandItem value={t("actions.markAllRead")} onSelect={() => runAction(onMarkAllRead)}>
            <CheckCheck />
            {t("actions.markAllRead")}
            <CommandShortcut>⇧A</CommandShortcut>
          </CommandItem>
          <CommandItem value={t("actions.focusSearch")} onSelect={() => runAction(onFocusSearch)}>
            <Search />
            {t("actions.focusSearch")}
            <CommandShortcut>/</CommandShortcut>
          </CommandItem>
          <CommandItem value={t("actions.addFeed")} onSelect={() => runAction(onAddFeed)}>
            <Plus />
            {t("actions.addFeed")}
          </CommandItem>
          <CommandItem value={t("actions.openSettings")} onSelect={() => runAction(onOpenSettings)}>
            <Settings />
            {t("actions.openSettings")}
          </CommandItem>
          <CommandItem value={t("actions.toggleTheme")} onSelect={() => runAction(toggleTheme)}>
            <SunMoon />
            {t("actions.toggleTheme")}
          </CommandItem>
          <CommandItem value={t("actions.shortcuts")} onSelect={() => runAction(onShowShortcuts)}>
            <Keyboard />
            {t("actions.shortcuts")}
            <CommandShortcut>?</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        {feeds.length > 0 && (
          <CommandGroup heading={t("groups.feeds")}>
            {feeds.map((feed) => (
              <CommandItem
                key={feed.id}
                value={`${t("groups.feeds")} ${feed.name}`}
                onSelect={() => runAction(() => onSelectFeed(feed.id))}
              >
                <Rss />
                {feed.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {categories.length > 0 && (
          <CommandGroup heading={t("groups.categories")}>
            {categories.map((category) => (
              <CommandItem
                key={category.id}
                value={`${t("groups.categories")} ${category.name}`}
                onSelect={() => runAction(() => onSelectCategory(category.name))}
              >
                <FolderOpen />
                {category.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {labels.length > 0 && (
          <CommandGroup heading={t("groups.labels")}>
            {labels.map((label) => (
              <CommandItem
                key={label.id}
                value={`${t("groups.labels")} ${label.name}`}
                onSelect={() => runAction(() => onSelectLabel(label.id))}
              >
                <Tag style={label.color ? { color: label.color } : undefined} />
                {label.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
