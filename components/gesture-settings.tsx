"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Bookmark, Check, Hand, MousePointer2, MoveHorizontal, Star, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SWIPE_ACTIONS, resetBackHint, resetGestureHint, setGesturePref, useGesturePrefs, useTouchRows, type SwipeActionId } from "@/lib/gestures";

const ACTION_ICON: Record<Exclude<SwipeActionId, "none">, LucideIcon> = { read: Check, later: Bookmark, star: Star };

/**
 * Settings → Lesen → Gesten (per device, localStorage): an illustrated
 * explanation (touch rows have no buttons — owner decision 2026-11-10), the
 * action of each swipe direction, haptic feedback, and "show the first-use
 * tip again". Directions are stored inline-relative ("end" = towards
 * inline-end), shown as → / ← for the current writing direction.
 */
export function GestureSettings() {
  const t = useTranslations("settings.gestures");
  const tHint = useTranslations("gestureHint");
  const prefs = useGesturePrefs();
  // The first-use tip only ever shows where rows have no buttons (touch, no mouse).
  const touchRows = useTouchRows();
  const [rtl, setRtl] = useState(false);
  useEffect(() => {
    setRtl(document.documentElement.dir === "rtl");
  }, []);

  const rows: Array<{ key: "swipeEnd" | "swipeStart"; label: string }> = [
    { key: "swipeEnd", label: rtl ? t("swipeLeft") : t("swipeRight") },
    { key: "swipeStart", label: rtl ? t("swipeRight") : t("swipeLeft") },
  ];

  return (
    <section
      id="gestures"
      className="scroll-mt-24 rounded-row border border-border/65 bg-card/85 p-5 sm:p-6"
      aria-labelledby="gesture-settings-title"
      data-testid="gesture-settings"
    >
      <div className="flex items-start gap-4">
        <div className="ui-brand-icon flex size-12 shrink-0 items-center justify-center rounded-row">
          <MoveHorizontal className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="gesture-settings-title" className="text-title-sm">
            {t("title")}
          </h2>
          <p className="mt-1 max-w-xl text-body-sm text-muted-foreground">{t("description")}</p>

          <figure className="mt-4" aria-labelledby="gesture-demo-caption" data-testid="gesture-demo">
            <figcaption id="gesture-demo-caption" className="sr-only">
              {t("demoLabel")}
            </figcaption>
            <div className="grid gap-2" aria-hidden>
              <DemoRow side="leading" action={prefs.swipeEnd} label={tHint(`actions.${prefs.swipeEnd}`)} rtl={rtl} />
              <DemoRow side="trailing" action={prefs.swipeStart} label={tHint(`actions.${prefs.swipeStart}`)} rtl={rtl} />
            </div>
            <ul className="mt-3 grid gap-2 text-body-sm text-muted-foreground">
              <DemoLine icon={MoveHorizontal} text={t("demoSwipe")} />
              <DemoLine icon={Hand} text={t("demoLongPress")} />
              <DemoLine icon={MousePointer2} text={t("demoMouse")} />
            </ul>
          </figure>

          <div className="mt-5 grid gap-3">
            {rows.map((row) => (
              <div key={row.key} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span id={`gesture-${row.key}`} className="text-body-sm font-medium">
                  {row.label}
                </span>
                <Select value={prefs[row.key]} onValueChange={(v) => setGesturePref(row.key, v as SwipeActionId)}>
                  <SelectTrigger aria-labelledby={`gesture-${row.key}`} className="h-10 w-full rounded-control border-border/70 bg-background/70 sm:w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-panel">
                    {SWIPE_ACTIONS.map((action) => (
                      <SelectItem key={action} value={action}>
                        {t(`actions.${action}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
            <div className="flex items-center justify-between gap-4 pt-1">
              <div>
                <div id="gesture-swipe-back" className="text-body-sm font-medium">
                  {t("swipeBack")}
                </div>
                <p className="text-footnote text-muted-foreground">{t("swipeBackDescription")}</p>
              </div>
              <Switch
                aria-labelledby="gesture-swipe-back"
                data-testid="gesture-swipe-back"
                checked={prefs.swipeBack}
                onCheckedChange={(checked) => setGesturePref("swipeBack", checked)}
              />
            </div>
            <div className="flex items-center justify-between gap-4 pt-1">
              <div>
                <div className="text-body-sm font-medium">{t("haptics")}</div>
                <p className="text-footnote text-muted-foreground">{t("hapticsDescription")}</p>
              </div>
              <Switch aria-label={t("haptics")} checked={prefs.haptics} onCheckedChange={(checked) => setGesturePref("haptics", checked)} />
            </div>
            {touchRows && (
              <div className="pt-1">
                <Button
                  type="button"
                  variant="outline"
                  data-testid="gesture-hint-reset"
                  onClick={() => {
                    resetGestureHint();
                    resetBackHint();
                    toast.success(t("hintReset"));
                  }}
                >
                  {t("showHint")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** A miniature row, half swiped: the revealed action in its colour (same tokens as the list). */
function DemoRow({ side, action, label, rtl }: { side: "leading" | "trailing"; action: SwipeActionId; label: string; rtl: boolean }) {
  const Icon = action === "none" ? null : ACTION_ICON[action];
  // Leading = revealed by a swipe towards inline-end (→ in LTR).
  const arrow = (side === "leading") !== rtl ? "→" : "←";
  return (
    <div className="ff-gesture-demo" data-side={side} data-action={action}>
      <div className="ff-gesture-demo-reveal">
        {side === "trailing" && <span className="text-caption font-semibold">{label}</span>}
        {Icon && <Icon className="size-4" />}
        {side === "leading" && <span className="text-caption font-semibold">{label}</span>}
      </div>
      <div className="ff-gesture-demo-row">
        <span className="ff-gesture-demo-arrow">{arrow}</span>
        <span className="ff-gesture-demo-line" />
      </div>
    </div>
  );
}

function DemoLine({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <li className="flex items-start gap-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
      <span>{text}</span>
    </li>
  );
}
