"use client";

import { useTranslations } from "next-intl";
import { ArrowRight, CheckCheck, PartyPopper } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EndOfListCardProps {
  /** Nothing unread remains in this view (server count). */
  caughtUp: boolean;
  /** Mark everything in the current view read (always shows an Undo toast). */
  onMarkAllRead?: () => void;
  isMarkingAllRead?: boolean;
  /** Next feed that has unread articles; omit when there is none / not applicable. */
  nextFeedName?: string | null;
  onContinue?: () => void;
  /** User setting: "Weiter zu …" also marks the current view read. */
  continueMarksRead?: boolean;
}

/**
 * Shown after the last row of every list view mode. This is the only way to
 * leave a feed in bulk — never a swipe or overscroll. Copy is deliberately
 * calm: no "X unread remain".
 */
export function EndOfListCard({
  caughtUp,
  onMarkAllRead,
  isMarkingAllRead = false,
  nextFeedName,
  onContinue,
  continueMarksRead = false,
}: EndOfListCardProps) {
  const t = useTranslations("articleList");
  const showMarkAll = !caughtUp && !!onMarkAllRead;
  const showContinue = !!nextFeedName && !!onContinue;

  return (
    <section
      data-testid="end-of-list-card"
      aria-label={caughtUp ? t("caughtUp") : t("endOfList")}
      className="col-span-full mt-2 flex flex-col items-center gap-4 rounded-2xl border border-border/60 bg-card/60 px-5 py-8 text-center"
    >
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {caughtUp ? <PartyPopper className="size-5" aria-hidden="true" /> : <CheckCheck className="size-5" aria-hidden="true" />}
      </div>
      <p className="text-sm font-semibold text-foreground">
        {caughtUp ? t("caughtUp") : t("endOfList")}
      </p>
      {(showMarkAll || showContinue) && (
        <div className="flex w-full max-w-xs flex-col gap-2">
          {showMarkAll && (
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-xl"
              disabled={isMarkingAllRead}
              onClick={() => onMarkAllRead?.()}
            >
              <CheckCheck className="size-4" aria-hidden="true" />
              {t("markAllRead")}
            </Button>
          )}
          {showContinue && (
            <Button
              type="button"
              className="h-11 min-w-0 rounded-xl"
              onClick={() => onContinue?.()}
            >
              <span className="truncate">{t("continueTo", { name: nextFeedName ?? "" })}</span>
              <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
            </Button>
          )}
          {showContinue && continueMarksRead && showMarkAll && (
            <p className="text-xs text-muted-foreground">{t("continueMarksReadHint")}</p>
          )}
        </div>
      )}
    </section>
  );
}
