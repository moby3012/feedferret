"use client";

import { useTranslations } from "next-intl";
import { SpoilerIcon } from "@/components/icons/spoiler-icon";
import { useReleaseAllSpoilers } from "@/hooks/use-rss-data";
import { nav } from "@/features/reader/nav/store";

/** The Spoiler view needs an explicit reveal each time it is entered. */
export function SpoilerGate({ onReveal }: { onReveal: () => void }) {
  const t = useTranslations("sidebar");
  const releaseAllSpoilers = useReleaseAllSpoilers();
  const leave = () => void nav.goScope({ kind: "all" });
  return (
    <div className="flex-1 flex items-center justify-center p-8 animate-fade-in">
      <div className="max-w-md text-center space-y-5">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-panel bg-warning/10 text-warning">
          <SpoilerIcon className="h-8 w-8" />
        </div>
        <div className="space-y-2">
          <h3 className="text-title font-semibold tracking-tight">{t("spoilerAhead")}</h3>
          <p className="text-body-sm text-muted-foreground leading-relaxed">{t("spoilerDescription")}</p>
        </div>
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onReveal}
            className="rounded-panel bg-warning-subtle px-6 py-3 text-body-sm font-semibold text-warning hover:bg-warning/20 active:scale-[0.98] transition-all"
          >
            {t("revealSpoilers")}
          </button>
          <button
            type="button"
            onClick={() => releaseAllSpoilers.mutate(undefined, { onSuccess: leave })}
            disabled={releaseAllSpoilers.isPending}
            className="text-footnote text-warning hover:underline disabled:opacity-50"
          >
            {releaseAllSpoilers.isPending ? t("clearingSpoilerFlags") : t("clearSpoilerFlags")}
          </button>
          <button type="button" onClick={leave} className="text-footnote text-muted-foreground hover:text-foreground">
            {t("takeMeBack")}
          </button>
        </div>
      </div>
    </div>
  );
}
