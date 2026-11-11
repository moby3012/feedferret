"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { MoveRight } from "lucide-react";
import { completeBackHint, useBackHintDue, useGesturePrefs, useTouchRows } from "@/lib/gestures";
import { useReaderOverList } from "./use-reader-swipe-back";

/**
 * One-time reader tip (same pattern as the list's gesture hint,
 * lib/gestures/coach.ts): the first reader opened on a touch device says
 * "swipe right to go back". Gone for good after "Verstanden", the first
 * swipe-back, or once the reader it showed in is closed (seen once).
 * Settings → Gesten & Hilfe → "Tipps wieder zeigen" brings it back.
 */
export function ReaderBackHint() {
  const t = useTranslations("backHint");
  const due = useBackHintDue();
  const touch = useTouchRows();
  const overList = useReaderOverList();
  const { swipeBack } = useGesturePrefs();
  const show = due && touch && overList && swipeBack;
  const shown = useRef(false);
  if (show) shown.current = true;
  useEffect(
    () => () => {
      if (shown.current) completeBackHint();
    },
    [],
  );
  if (!show) return null;
  return (
    <aside className="ff-reader-back-hint" role="note" aria-label={t("label")} data-testid="reader-back-hint">
      <MoveRight className="size-5 shrink-0 text-brand rtl:-scale-x-100" aria-hidden />
      <p className="min-w-0 flex-1 text-body-sm font-semibold text-foreground">{t("text")}</p>
      <button type="button" className="ff-reader-back-hint-ok hit-slop" onClick={completeBackHint}>
        {t("dismiss")}
      </button>
    </aside>
  );
}
