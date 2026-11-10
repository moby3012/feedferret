"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Bookmark } from "lucide-react";
import { buildBookmarkletHref } from "@/lib/bookmarklet";

/**
 * Draggable "Subscribe in FeedFerret" bookmarklet. React refuses to render
 * `javascript:` hrefs, so the href is attached to the DOM node after mount.
 */
export function SubscribeBookmarklet({ showHint = true }: { showHint?: boolean }) {
  const t = useTranslations("bookmarklet");
  const linkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    linkRef.current?.setAttribute("href", buildBookmarkletHref(window.location.origin));
  }, []);

  return (
    <div className="flex flex-col gap-1.5">
      <a
        ref={linkRef}
        draggable
        onClick={(e) => e.preventDefault()}
        title={t("dragHint")}
        className="inline-flex w-fit cursor-grab items-center gap-1.5 rounded-control border border-border/70 bg-background/70 px-3 py-1.5 text-footnote text-foreground active:cursor-grabbing"
      >
        <Bookmark className="h-3.5 w-3.5" aria-hidden />
        {t("label")}
      </a>
      {showHint && <p className="text-footnote text-muted-foreground">{t("dragHint")}</p>}
    </div>
  );
}
