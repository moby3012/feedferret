"use client";

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// ResponsiveOverlay, kind "menu" (spec §3): a bottom sheet for touch, a
// pointer-anchored dropdown for mouse / keyboard. One item list drives both,
// so every action exists in both forms. Overlays never nest: a submenu is a
// step INSIDE the sheet (with a back row), a Radix submenu in the dropdown.
// Every "…" of the app goes through here (list, row, reader, feed).

export interface OverlayMenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Not called for an item with `children` (it opens the submenu / sheet step). */
  onSelect(): void;
  disabled?: boolean;
  /** Draws a separator above this item. */
  separated?: boolean;
  /** A submenu (sheet: an in-sheet step with a back row). */
  children?: OverlayMenuItem[];
  /** A checkable item: toggles in place, the menu stays open. */
  checked?: boolean;
  /** Small colour dot before the label (labels). */
  swatch?: string;
  /** Destructive styling. */
  danger?: boolean;
}

export interface ResponsiveMenuProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** "sheet" for touch / pen, "menu" for mouse and keyboard. */
  mode: "sheet" | "menu";
  title: string;
  /** Secondary line under the title (e.g. the original headline). */
  description?: string;
  /** Viewport point the menu opens at (mode "menu"). */
  anchor: { x: number; y: number };
  /** Preferred side of the dropdown (mode "menu"); it flips on collision. */
  side?: "top" | "bottom";
  items: OverlayMenuItem[];
  /** Focus goes back here on close (the row the menu belongs to). */
  returnFocus?: () => HTMLElement | null;
  testId?: string;
}

export function ResponsiveMenu(p: ResponsiveMenuProps) {
  const restoreFocus = (e: Event) => {
    const el = p.returnFocus?.();
    if (!el) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
  };
  // Close first, then act: an action that navigates (prev/next article) must
  // run after the menu's history entry is gone.
  const select = (item: OverlayMenuItem) => {
    p.onOpenChange(false);
    item.onSelect();
  };

  if (p.mode === "sheet") return <MenuSheet {...p} select={select} restoreFocus={restoreFocus} />;

  const renderItem = (item: OverlayMenuItem) => {
    const content = (
      <>
        {item.swatch ? <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.swatch }} aria-hidden /> : item.icon && <item.icon className="size-4 shrink-0" aria-hidden />}
        {item.label}
      </>
    );
    if (item.children) {
      return (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={item.disabled} className="gap-2.5" data-item-id={item.id}>
            {content}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">{item.children.map((child) => <div key={child.id} className="contents">{renderItem(child)}</div>)}</DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    }
    if (item.checked !== undefined) {
      return (
        <DropdownMenuCheckboxItem checked={item.checked} disabled={item.disabled} onSelect={(e) => e.preventDefault()} onCheckedChange={() => item.onSelect()} className="gap-2.5">
          {content}
        </DropdownMenuCheckboxItem>
      );
    }
    return (
      <DropdownMenuItem disabled={item.disabled} onSelect={() => select(item)} className={cn("gap-2.5", item.danger && "text-destructive focus:text-destructive")}>
        {content}
      </DropdownMenuItem>
    );
  };

  return (
    <DropdownMenu open={p.open} onOpenChange={p.onOpenChange}>
      <DropdownMenuTrigger asChild>
        {/* Invisible anchor at the pointer; the menu positions against it. */}
        <span aria-hidden tabIndex={-1} className="pointer-events-none fixed size-px" style={{ left: p.anchor.x, top: p.anchor.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-testid={p.testId}
        align="start"
        side={p.side}
        sideOffset={2}
        className="w-64"
        onCloseAutoFocus={restoreFocus}
        aria-label={p.title}
      >
        <DropdownMenuLabel className={cn("line-clamp-2 text-footnote text-muted-foreground")}>{p.description ?? p.title}</DropdownMenuLabel>
        {p.items.map((item) => (
          <div key={item.id} className="contents">
            {item.separated && <DropdownMenuSeparator />}
            {renderItem(item)}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuSheet(p: ResponsiveMenuProps & { select(item: OverlayMenuItem): void; restoreFocus(e: Event): void }) {
  // The open submenu (one level): its items replace the list, a back row leads up.
  const [step, setStep] = useState<string | null>(null);
  useEffect(() => {
    if (!p.open) setStep(null);
  }, [p.open]);
  const parent = step ? p.items.find((item) => item.id === step && item.children) : undefined;
  const items = parent?.children ?? p.items;

  const row = "flex min-h-12 w-full items-center gap-3 rounded-control px-3 text-start text-body font-medium active:bg-surface-sunken disabled:opacity-50";
  return (
    <Drawer open={p.open} onOpenChange={p.onOpenChange}>
      {/* select-none + no callout: the sheet opens under a still-pressed finger (long-press);
          iOS would otherwise start its text selection on the sheet's title / items. */}
      <DrawerContent data-testid={p.testId} onCloseAutoFocus={p.restoreFocus} className="select-none [-webkit-touch-callout:none]">
        <DrawerHeader className="text-start">
          <DrawerTitle className="line-clamp-2">{p.title}</DrawerTitle>
          {p.description ? <DrawerDescription className="line-clamp-2">{p.description}</DrawerDescription> : <DrawerDescription className="sr-only">{p.title}</DrawerDescription>}
        </DrawerHeader>
        <div role="menu" aria-label={parent ? parent.label : p.title} className="flex flex-col overflow-y-auto px-2 pb-[calc(var(--safe-b)+12px)]">
          {parent && (
            <button type="button" className={cn(row, "text-muted-foreground")} onClick={() => setStep(null)} data-testid="menu-sheet-back">
              <ChevronLeft className="size-5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{parent.label}</span>
            </button>
          )}
          {items.map((item) => (
            <div key={item.id} className="contents">
              {item.separated && <div role="separator" className="my-1 h-px bg-divider" />}
              {item.children ? (
                <button type="button" role="menuitem" aria-haspopup="menu" disabled={item.disabled} onClick={() => setStep(item.id)} className={row}>
                  {item.icon && <item.icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              ) : item.checked !== undefined ? (
                <button type="button" role="menuitemcheckbox" aria-checked={item.checked} disabled={item.disabled} onClick={() => item.onSelect()} className={row}>
                  {item.swatch ? (
                    <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden>
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: item.swatch }} />
                    </span>
                  ) : (
                    item.icon && <item.icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.checked && <Check className="size-5 shrink-0 text-brand" aria-hidden />}
                </button>
              ) : (
                <button type="button" role="menuitem" disabled={item.disabled} onClick={() => p.select(item)} className={cn(row, item.danger && "text-destructive")}>
                  {item.icon && <item.icon className={cn("size-5 shrink-0", item.danger ? "text-destructive" : "text-muted-foreground")} aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              )}
            </div>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
