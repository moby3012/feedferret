"use client";

import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Hand } from "lucide-react";
import { Button } from "@/components/ui/button";
import { completeGestureHint, documentDir, useGestureHintDue, type SwipeActionId } from "@/lib/gestures";
import { prefersReducedMotion } from "@/lib/gestures/guards";
import { markInAppNavigation } from "@/lib/in-app-back";
import type { RowSwipeMap } from "./article-row";

const COARSE = "(pointer: coarse)";

function subscribeCoarse(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const list = window.matchMedia(COARSE);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}
const isCoarse = () => typeof window.matchMedia === "function" && window.matchMedia(COARSE).matches;

/** Touch-first input; `false` on the server and during hydration (post-mount widget only). */
function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribeCoarse, isCoarse, () => false);
}

/**
 * First-use gesture coach mark (owner decision 2026-11-10): on a touch device
 * rows carry no buttons, so the first list explains the gestures once — a
 * chip above the rows ("Wischen: ← Später · → Gelesen", "Lange drücken: alle
 * Aktionen") and a one-time animated nudge of the first row that shows both
 * reveal colours. Gone for good after "Verstanden", "Anpassen" or the first
 * real swipe / long-press (lib/gestures/coach.ts). No nudge under reduced motion.
 */
export function GestureHint({ swipeMap, scrollRoot, active }: { swipeMap: RowSwipeMap; scrollRoot: HTMLElement | null; active: boolean }) {
  const t = useTranslations("gestureHint");
  const due = useGestureHintDue();
  const coarse = useCoarsePointer();
  const show = active && due && coarse;

  // The nudge: the first row slides open to each side once (stepped ≤320 ms
  // transitions: the motion ceiling holds). Any touch on the list stops it at
  // once — the finger owns the row's transform.
  useEffect(() => {
    if (!show || !scrollRoot || prefersReducedMotion()) return;
    const row = scrollRoot.querySelector<HTMLElement>(".ff-row");
    if (!row) return;
    const timers: number[] = [];
    const stop = () => {
      timers.forEach((id) => window.clearTimeout(id));
      timers.length = 0;
      row.removeAttribute("data-coach");
    };
    const steps: Array<[number, string | null]> = [
      [600, "lead"],
      [1500, ""],
      [1900, "trail"],
      [2800, ""],
      [3200, null],
    ];
    for (const [at, value] of steps) {
      timers.push(window.setTimeout(() => (value === null ? row.removeAttribute("data-coach") : row.setAttribute("data-coach", value)), at));
    }
    scrollRoot.addEventListener("pointerdown", stop, { capture: true, passive: true });
    return () => {
      stop();
      scrollRoot.removeEventListener("pointerdown", stop, { capture: true });
    };
  }, [show, scrollRoot]);

  if (!show) return null;
  const rtl = documentDir() === "rtl";
  // `end` = towards inline-end: → in LTR, ← in RTL.
  const left: SwipeActionId = rtl ? swipeMap.end : swipeMap.start;
  const right: SwipeActionId = rtl ? swipeMap.start : swipeMap.end;
  return (
    <aside className="ff-gesture-hint ff-span-all" role="note" aria-label={t("label")} data-testid="gesture-hint">
      <Hand className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-body-sm font-semibold text-foreground">{t("title")}</p>
        <p className="mt-0.5 text-footnote text-muted-foreground" data-testid="gesture-hint-swipe">
          {t("swipe", { left: t(`actions.${left}`), right: t(`actions.${right}`) })}
        </p>
        <p className="text-footnote text-muted-foreground">{t("longPress")}</p>
        <div className="mt-2 flex items-center gap-2">
          <Button type="button" size="sm" onClick={completeGestureHint}>
            {t("dismiss")}
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link
              href="/settings?tab=reading#gestures"
              onClick={() => {
                markInAppNavigation();
                completeGestureHint();
              }}
            >
              {t("customize")}
            </Link>
          </Button>
        </div>
      </div>
    </aside>
  );
}
