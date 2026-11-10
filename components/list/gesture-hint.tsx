"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Hand } from "lucide-react";
import { Button } from "@/components/ui/button";
import { claimGestureNudge, completeGestureHint, documentDir, useGestureHintDue, useTouchRows, type SwipeActionId } from "@/lib/gestures";
import { prefersReducedMotion } from "@/lib/gestures/guards";
import { markInAppNavigation } from "@/lib/in-app-back";
import type { RowSwipeMap } from "./article-row";

/** Share of the first row that must be on screen before it is nudged. */
const NUDGE_VISIBLE_RATIO = 0.9;

/**
 * First-use gesture coach mark (owner decision 2026-11-10): on a touch-only
 * device rows carry no buttons, so the list explains the gestures once — a
 * chip right above the rows ("Wischen: ← Später · → Gelesen", "Lange drücken:
 * alle Aktionen") and an animated nudge of the first row that shows the
 * reveal colours. The nudge waits until the first row is actually on screen
 * and plays at most once per browser session. Gone for good after
 * "Verstanden", "Anpassen" or the first real swipe / long-press
 * (lib/gestures/coach.ts). No nudge under reduced motion or without swipes.
 */
export function GestureHint({ swipeMap, scrollRoot, active }: { swipeMap: RowSwipeMap; scrollRoot: HTMLElement | null; active: boolean }) {
  const t = useTranslations("gestureHint");
  const due = useGestureHintDue();
  const touchRows = useTouchRows();
  const show = active && due && touchRows;
  const swipes = swipeMap.start !== "none" || swipeMap.end !== "none";

  // The nudge: the first row slides open to each configured side once
  // (stepped ≤320 ms transitions: the motion ceiling holds). Any touch on the
  // list stops it at once — the finger owns the row's transform.
  useEffect(() => {
    if (!show || !swipes || !scrollRoot || prefersReducedMotion() || typeof IntersectionObserver !== "function") return;
    const row = scrollRoot.querySelector<HTMLElement>(".ff-row");
    if (!row) return;
    const timers: number[] = [];
    const stop = () => {
      timers.forEach((id) => window.clearTimeout(id));
      timers.length = 0;
      row.removeAttribute("data-coach");
    };
    const play = () => {
      if (!claimGestureNudge()) return;
      // `lead` = revealed by a swipe towards inline-end (swipeMap.end).
      const sides = [swipeMap.end !== "none" ? "lead" : null, swipeMap.start !== "none" ? "trail" : null].filter((s): s is string => s !== null);
      let at = 600;
      for (const side of sides) {
        timers.push(window.setTimeout(() => row.setAttribute("data-coach", side), at));
        timers.push(window.setTimeout(() => row.setAttribute("data-coach", ""), at + 900));
        at += 1300;
      }
      timers.push(window.setTimeout(() => row.removeAttribute("data-coach"), at));
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting && e.intersectionRatio >= NUDGE_VISIBLE_RATIO)) return;
        io.disconnect();
        play();
      },
      // Compact: the floating tab bar covers the scroller's last ~5 rem — a row under it is not "on screen".
      { root: scrollRoot, threshold: NUDGE_VISIBLE_RATIO, rootMargin: "0px 0px -80px 0px" },
    );
    io.observe(row);
    scrollRoot.addEventListener("pointerdown", stop, { capture: true, passive: true });
    return () => {
      io.disconnect();
      stop();
      scrollRoot.removeEventListener("pointerdown", stop, { capture: true });
    };
  }, [show, swipes, scrollRoot, swipeMap.start, swipeMap.end]);

  if (!show) return null;
  const rtl = documentDir() === "rtl";
  // `end` = towards inline-end: → in LTR, ← in RTL.
  const left: SwipeActionId = rtl ? swipeMap.end : swipeMap.start;
  const right: SwipeActionId = rtl ? swipeMap.start : swipeMap.end;
  const dismiss = () => {
    // The chip unmounts with the focused button: hand focus to the list, not <body>.
    const target = scrollRoot?.querySelector<HTMLElement>(".ff-row-content") ?? scrollRoot;
    completeGestureHint();
    if (target) {
      if (target === scrollRoot && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }
  };
  return (
    <aside className="ff-gesture-hint ff-span-all" role="note" aria-label={t("label")} data-testid="gesture-hint">
      <Hand className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-body-sm font-semibold text-foreground">{swipes ? t("title") : t("titleLongPress")}</p>
        {swipes && (
          <p className="mt-0.5 text-footnote text-muted-foreground" data-testid="gesture-hint-swipe">
            {t("swipe", { left: t(`actions.${left}`), right: t(`actions.${right}`) })}
          </p>
        )}
        <p className="text-footnote text-muted-foreground">{t("longPress")}</p>
        <div className="mt-2 flex items-center gap-2">
          <Button type="button" size="sm" onClick={dismiss}>
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
