"use client";

import type { LucideIcon } from "lucide-react";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// ResponsiveOverlay, kind "menu" (spec §3): a bottom sheet for touch, a
// pointer-anchored dropdown for mouse / keyboard. One item list drives both,
// so every action exists in both forms. Overlays never nest.

export interface OverlayMenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect(): void;
  disabled?: boolean;
  /** Draws a separator above this item. */
  separated?: boolean;
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

  if (p.mode === "sheet") {
    return (
      <Drawer open={p.open} onOpenChange={p.onOpenChange}>
        <DrawerContent data-testid={p.testId} onCloseAutoFocus={restoreFocus}>
          <DrawerHeader className="text-start">
            <DrawerTitle className="line-clamp-2">{p.title}</DrawerTitle>
            {p.description ? <DrawerDescription className="line-clamp-2">{p.description}</DrawerDescription> : <DrawerDescription className="sr-only">{p.title}</DrawerDescription>}
          </DrawerHeader>
          <div role="menu" aria-label={p.title} className="flex flex-col px-2 pb-[calc(var(--safe-b)+12px)]">
            {p.items.map((item) => (
              <div key={item.id} className="contents">
                {item.separated && <div role="separator" className="my-1 h-px bg-divider" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    p.onOpenChange(false);
                    item.onSelect();
                  }}
                  className="flex min-h-12 items-center gap-3 rounded-control px-3 text-start text-body font-medium active:bg-surface-sunken disabled:opacity-50"
                >
                  {item.icon && <item.icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              </div>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <DropdownMenu open={p.open} onOpenChange={p.onOpenChange}>
      <DropdownMenuTrigger asChild>
        {/* Invisible anchor at the pointer; the menu positions against it. */}
        <span aria-hidden tabIndex={-1} className="pointer-events-none fixed size-px" style={{ left: p.anchor.x, top: p.anchor.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent data-testid={p.testId} align="start" sideOffset={2} className="w-64" onCloseAutoFocus={restoreFocus} aria-label={p.title}>
        <DropdownMenuLabel className={cn("line-clamp-2 text-footnote text-muted-foreground")}>{p.description ?? p.title}</DropdownMenuLabel>
        {p.items.map((item) => (
          <div key={item.id} className="contents">
            {item.separated && <DropdownMenuSeparator />}
            <DropdownMenuItem disabled={item.disabled} onSelect={() => item.onSelect()} className="gap-2.5">
              {item.icon && <item.icon className="size-4 shrink-0" aria-hidden />}
              {item.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
