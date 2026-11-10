"use client";

import { useTranslations } from "next-intl";
import type { Citation } from "@/lib/briefing/types";

/**
 * Inline source chip after a briefing sentence: index number only (the model
 * never produces links). 24 px visual, 44 px hit area. Activating it opens the
 * cited article in the reader through the nav store (`onOpen`).
 */
export function CitationChip({ citation, index, onOpen }: { citation: Citation; index: number; onOpen: (articleId: string) => void }) {
  const t = useTranslations("briefing");
  const label = t("source", { index, title: citation.title, feed: citation.feedName });
  return (
    <button
      type="button"
      data-citation-id={citation.articleId}
      aria-label={label}
      title={`${citation.title} — ${citation.feedName}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(citation.articleId);
      }}
      className="relative ms-1 inline-flex h-5 min-w-5 items-center justify-center rounded-chip bg-accent-subtle px-1 align-[0.1em] text-caption tabular-nums text-foreground transition-colors duration-(--dur-fast) after:absolute after:-inset-3 after:content-[''] hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {index}
    </button>
  );
}
