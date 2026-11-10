"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Hand, Keyboard, CheckCheck, MousePointer2, MoveHorizontal, Rss, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GestureSettings } from "@/components/gesture-settings";
import { PrefRow } from "@/components/settings/pref-row";
import { resetFeedsHint, useTouchRows } from "@/lib/gestures";

/**
 * Settings → Gesten & Hilfe (owner requirement 2026-11-10: touch rows have no
 * buttons, so every gesture is explained here): the swipe mapping (per
 * device), a reference of every gesture by screen, keyboard shortcuts, and
 * "show the tips again".
 */
export function GesturesHelpSettings() {
  const t = useTranslations();
  return (
    <>
      <GestureSettings />
      <GestureReference />
      {/* Keyboard shortcuts */}
      <PrefRow icon={Keyboard} title={t("keyboard.title")} description={t("keyboard.description")}>
        <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground sm:min-w-80">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <span className="font-mono text-foreground">j / k</span>
            <span>
              {t("keyboard.nextArticle")} / {t("keyboard.previousArticle")}
            </span>
            <span className="font-mono text-foreground">n / p</span>
            <span>
              {t("keyboard.nextUnread")} / {t("keyboard.previousUnread")}
            </span>
            <span className="font-mono text-foreground">m / s</span>
            <span>
              {t("keyboard.toggleRead")} / {t("keyboard.toggleStar")}
            </span>
            <span className="font-mono text-foreground">/</span>
            <span>{t("keyboard.focusSearch")}</span>
            <span className="font-mono text-foreground">Ctrl/⌘ K</span>
            <span>{t("keyboard.commandPalette")}</span>
            <span className="font-mono text-foreground">?</span>
            <span>{t("keyboard.toggleHelp")}</span>
          </div>
        </div>
      </PrefRow>
    </>
  );
}

/** Every gesture, grouped by where it works. */
function GestureReference() {
  const t = useTranslations("settings.gesturesHelp");
  const touchRows = useTouchRows();
  const groups: Array<{ id: string; title: string; items: Array<{ icon: LucideIcon; gesture: string; result: string }> }> = [
    {
      id: "list",
      title: t("list.title"),
      items: [
        { icon: MoveHorizontal, gesture: t("list.swipe"), result: t("list.swipeResult") },
        { icon: Hand, gesture: t("longPress"), result: t("list.longPressResult") },
        { icon: ArrowDown, gesture: t("list.pull"), result: t("list.pullResult") },
      ],
    },
    {
      id: "feeds",
      title: t("feeds.title"),
      items: [
        { icon: Hand, gesture: t("longPress"), result: t("feeds.longPressResult") },
        { icon: Rss, gesture: t("feeds.arrow"), result: t("feeds.arrowResult") },
        { icon: CheckCheck, gesture: t("feeds.markAll"), result: t("feeds.markAllResult") },
      ],
    },
    {
      id: "reader",
      title: t("reader.title"),
      items: [
        { icon: ArrowUp, gesture: t("reader.pullNext"), result: t("reader.pullNextResult") },
        { icon: MoveHorizontal, gesture: t("reader.edge"), result: t("reader.edgeResult") },
      ],
    },
    {
      id: "everywhere",
      title: t("everywhere.title"),
      items: [
        { icon: Hand, gesture: t("everywhere.tabTwice"), result: t("everywhere.tabTwiceResult") },
        { icon: MousePointer2, gesture: t("everywhere.rightClick"), result: t("everywhere.rightClickResult") },
      ],
    },
  ];
  return (
    <section
      id="gesture-help"
      className="scroll-mt-24 rounded-row border border-border/65 bg-card/85 p-5 shadow-sm sm:p-6"
      aria-labelledby="gesture-help-title"
      data-testid="gesture-help"
    >
      <h2 id="gesture-help-title" className="text-title-sm">
        {t("title")}
      </h2>
      <p className="mt-1 max-w-xl text-body-sm text-muted-foreground">{t("description")}</p>
      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        {groups.map((group) => (
          <div key={group.id}>
            <h3 className="text-body-sm font-semibold text-foreground">{group.title}</h3>
            <dl className="mt-2 grid gap-2">
              {group.items.map((item) => (
                <div key={item.gesture} className="flex items-start gap-2 text-body-sm">
                  <item.icon className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                  <div className="min-w-0">
                    <dt className="font-medium text-foreground">{item.gesture}</dt>
                    <dd className="text-muted-foreground">{item.result}</dd>
                  </div>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      {touchRows && (
        <div className="mt-5">
          <Button
            type="button"
            variant="outline"
            data-testid="feeds-hint-reset"
            onClick={() => {
              resetFeedsHint();
              toast.success(t("feedsHintReset"));
            }}
          >
            {t("showFeedsHint")}
          </Button>
        </div>
      )}
    </section>
  );
}
