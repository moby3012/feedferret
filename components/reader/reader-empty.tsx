"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";

/** Reader column with no article (wide layouts). Lives outside the lazily loaded reader chunk. */
export function ReaderEmptyState() {
  const t = useTranslations("articleReader");
  return (
    <div className="flex-1 flex items-center justify-center bg-background animate-fade-in">
      <div className="text-center max-w-md px-8">
        <div className="w-24 h-24 rounded-sheet bg-muted flex items-center justify-center mx-auto mb-8 shadow-overlay overflow-hidden p-6 border border-border/50">
          <Image src="/logo.svg" alt="FeedFerret Logo" width={48} height={48} className="w-12 h-12 invert dark:invert-0" />
        </div>
        <h2 className="text-headline font-semibold text-foreground mb-3 text-balance">{t("selectArticle")}</h2>
        <p className="text-title-sm text-muted-foreground leading-relaxed">{t("selectArticleDescription")}</p>
      </div>
    </div>
  );
}
