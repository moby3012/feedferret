"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Bookmark, ChevronLeft, Circle, CircleDot, Share2, Star } from "lucide-react";
import type { Article } from "@/lib/rss-data";
import { cn } from "@/lib/utils";
import { ChromeButton, type ReaderToggleProps } from "./chrome-button";

/**
 * Compact bottom action pill (spec §4.7; tab-bar geometry, never hides):
 * Zurück · Favorit · Gelesen · Später · Teilen · …. Back sits first, in thumb
 * reach (the top bar's chevron stays too; owner report 2026-11-11: the top
 * corner is hard to reach one-handed). Six items fit 320 px (≥ 44 px each).
 * Toggles show their state (filled = on).
 */
export function ReaderActionPill({ article, more, onBack, ...a }: Omit<ReaderToggleProps, "onOpenOriginal"> & { article: Article; more: ReactNode; onBack: () => void }) {
  const t = useTranslations("articleReader");
  const tList = useTranslations("articleList");
  return (
    <nav className="ff-reader-pill" aria-label={t("articleActions")}>
      <ChromeButton onClick={onBack} aria-label={t("back")} data-testid="reader-pill-back">
        <ChevronLeft className="size-6 rtl:-scale-x-100" />
      </ChromeButton>
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
