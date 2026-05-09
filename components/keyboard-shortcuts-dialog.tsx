"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";

type Shortcut = {
  keys: string[];
  description: string;
};

type Group = {
  title: string;
  items: Shortcut[];
};

const groups: Group[] = [
  {
    title: "Navigation",
    items: [
      { keys: ["j"], description: "Next article" },
      { keys: ["k"], description: "Previous article" },
      { keys: ["n"], description: "Next unread article" },
      { keys: ["p"], description: "Previous unread article" },
      { keys: ["o"], description: "Open original in new tab" },
    ],
  },
  {
    title: "Actions",
    items: [
      { keys: ["s"], description: "Toggle star on current article" },
      { keys: ["m"], description: "Toggle read/unread" },
      { keys: ["r"], description: "Refresh feeds" },
      { keys: ["Shift", "A"], description: "Mark all as read in current view" },
    ],
  },
  {
    title: "Search",
    items: [
      { keys: ["/"], description: "Focus search" },
      { keys: ["Esc"], description: "Clear search" },
      { keys: ["Shift", "S"], description: "Save current search" },
    ],
  },
  {
    title: "Help",
    items: [{ keys: ["?"], description: "Toggle this help overlay" }],
  },
];

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Power-user shortcuts for fast navigation. Disabled while typing in inputs.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {groups.map((group) => (
            <div key={group.title} className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.title}
              </h4>
              <ul className="space-y-1.5">
                {group.items.map((item) => (
                  <li
                    key={item.description}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="text-foreground/90">{item.description}</span>
                    <KbdGroup>
                      {item.keys.map((k, i) => (
                        <Kbd key={i}>{k}</Kbd>
                      ))}
                    </KbdGroup>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
