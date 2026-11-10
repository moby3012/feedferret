"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { MoveHorizontal } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SWIPE_ACTIONS, setGesturePref, useGesturePrefs, type SwipeActionId } from "@/lib/gestures";

/**
 * Settings → Lesen → Wischgesten (per device, localStorage): the action of
 * each swipe direction and haptic feedback. Directions are stored inline-
 * relative ("end" = towards inline-end), shown as → / ← for the current
 * writing direction.
 */
export function GestureSettings() {
  const t = useTranslations("settings.gestures");
  const prefs = useGesturePrefs();
  const [rtl, setRtl] = useState(false);
  useEffect(() => {
    setRtl(document.documentElement.dir === "rtl");
  }, []);

  const rows: Array<{ key: "swipeEnd" | "swipeStart"; label: string }> = [
    { key: "swipeEnd", label: rtl ? t("swipeLeft") : t("swipeRight") },
    { key: "swipeStart", label: rtl ? t("swipeRight") : t("swipeLeft") },
  ];

  return (
    <section className="rounded-row border border-border/65 bg-card/85 p-5 shadow-sm sm:p-6" aria-labelledby="gesture-settings-title" data-testid="gesture-settings">
      <div className="flex items-start gap-4">
        <div className="ui-brand-icon flex size-12 shrink-0 items-center justify-center rounded-row">
          <MoveHorizontal className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="gesture-settings-title" className="text-title-sm">
            {t("title")}
          </h2>
          <p className="mt-1 max-w-xl text-body-sm text-muted-foreground">{t("description")}</p>
          <div className="mt-4 grid gap-3">
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
                <div className="text-body-sm font-medium">{t("haptics")}</div>
                <p className="text-footnote text-muted-foreground">{t("hapticsDescription")}</p>
              </div>
              <Switch aria-label={t("haptics")} checked={prefs.haptics} onCheckedChange={(checked) => setGesturePref("haptics", checked)} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
