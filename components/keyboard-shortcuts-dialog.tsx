"use client";

import { useTranslations } from "next-intl";
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

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("keyboard");

  const groups: Group[] = [
    {
      title: t("navigation"),
      items: [
        { keys: ["j"], description: t("nextArticle") },
        { keys: ["k"], description: t("previousArticle") },
        { keys: ["n"], description: t("nextUnread") },
        { keys: ["p"], description: t("previousUnread") },
        { keys: ["o"], description: t("openOriginal") },
      ],
    },
    {
      title: t("actions"),
      items: [
        { keys: ["s"], description: t("toggleStar") },
        { keys: ["l"], description: t("toggleReadLater") },
        { keys: ["m"], description: t("toggleRead") },
        { keys: ["r"], description: t("refreshFeeds") },
        { keys: ["Shift", "A"], description: t("markAllRead") },
      ],
    },
    {
      title: t("search"),
      items: [
        { keys: ["/"], description: t("focusSearch") },
        { keys: ["Esc"], description: t("clearSearch") },
        { keys: ["Shift", "S"], description: t("saveSearch") },
      ],
    },
    {
      title: t("help"),
      items: [{ keys: ["?"], description: t("toggleHelp") }],
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description")}
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
