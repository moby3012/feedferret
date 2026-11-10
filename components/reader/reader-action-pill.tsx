"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Bookmark, Circle, CircleDot, Share2, Star } from "lucide-react";
import type { Article } from "@/lib/rss-data";
import { cn } from "@/lib/utils";
import { ChromeButton, type ReaderToggleProps } from "./chrome-button";

/**
 * Compact bottom action pill (spec §4.7; tab-bar geometry, never hides):
 * Favorit · Gelesen · Später · Teilen · …. Toggles show their state (filled =
 * on). No button doubles as Back.
 */
export function ReaderActionPill({ article, more, ...a }: Omit<ReaderToggleProps, "onOpenOriginal"> & { article: Article; more: ReactNode }) {
  const t = useTranslations("articleReader");
  const tList = useTranslations("articleList");
  return (
    <nav className="ff-reader-pill" aria-label={t("articleActions")}>
      <ChromeButton onClick={a.onToggleStar} pressed={article.isStarred} aria-label={article.isStarred ? tList("removeStar") : tList("star")}>
        <Star className={cn("size-6", article.isStarred && "fill-brand-secondary text-brand-secondary")} />
      </ChromeButton>
      <ChromeButton onClick={a.onToggleRead} pressed={article.isRead} aria-label={article.isRead ? tList("markAsUnread") : tList("markAsRead")}>
        {article.isRead ? <Circle className="size-6" /> : <CircleDot className="size-6 text-primary" />}
      </ChromeButton>
      <ChromeButton onClick={a.onToggleLater} pressed={article.isReadLater} aria-label={article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")}>
        <Bookmark className={cn("size-6", article.isReadLater && "fill-current text-primary")} />
      </ChromeButton>
      <ChromeButton onClick={a.onShare} aria-label={t("share")}>
        <Share2 className="size-6" />
      </ChromeButton>
      {more}
    </nav>
  );
}
