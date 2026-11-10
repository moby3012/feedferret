"use client";

import { forwardRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Bookmark, ChevronDown, ChevronLeft, ChevronUp, CircleDot, Circle, ExternalLink, Share2, Star } from "lucide-react";
import type { Article } from "@/lib/rss-data";
import { cn } from "@/lib/utils";
import { ChromeButton, type ReaderNavProps, type ReaderToggleProps } from "./chrome-button";
import { FeedFavicon } from "./feed-favicon";

/**
 * Reader top bar (spec §4.7). Compact: [Back][feed][↑][↓][Aa]. Wide:
 * [Back][↑][↓] … [Favorit][Später][Gelesen][Teilen][Original][Aa][…].
 * Hides on scroll (data-chrome on the reader root, app/styles/reader-chrome.css);
 * the 2 px progress line sits on its lower edge and stays visible when it hides.
 */
export const ReaderTopBar = forwardRef<
  HTMLElement,
  ReaderNavProps &
    ReaderToggleProps & {
      article: Article;
      onBack: () => void;
      onOpenFeed: (feedId: string) => void;
      typography: ReactNode;
      more: ReactNode;
    }
>(function ReaderTopBar(props, ref) {
  const { article } = props;
  const t = useTranslations("articleReader");
  const tList = useTranslations("articleList");
  return (
    <header ref={ref} className="ff-reader-bar">
      <div className="ff-reader-bar-row">
        <ChromeButton onClick={props.onBack} aria-label={t("back")}>
          <ChevronLeft className="size-6" />
        </ChromeButton>
        <button
          type="button"
          onClick={() => props.onOpenFeed(article.feedId)}
          className="ff-reader-bar-feed hit-slop"
          aria-label={t("showFeed", { feed: article.feedName })}
        >
          <FeedFavicon feedIcon={article.feedIcon} feedName={article.feedName} articleLink={article.link} size={20} />
          <span className="truncate">{article.feedName}</span>
        </button>
        <ChromeButton onClick={props.onPrevious} disabled={!props.hasPrevious} aria-label={t("previousArticle")} title={`${t("previousArticle")} (k)`}>
          <ChevronUp className="size-5" />
        </ChromeButton>
        <ChromeButton onClick={props.onNext} disabled={!props.hasNext} aria-label={t("nextArticle")} title={`${t("nextArticle")} (j)`}>
          <ChevronDown className="size-5" />
        </ChromeButton>
        <span className="hidden flex-1 wide:block" />
        <div className="hidden items-center wide:flex">
          <ChromeButton
            onClick={props.onToggleStar}
            pressed={article.isStarred}
            aria-label={article.isStarred ? tList("removeStar") : tList("star")}
            title={`${article.isStarred ? tList("removeStar") : tList("star")} (s)`}
          >
            <Star className={cn("size-5", article.isStarred && "fill-brand-secondary text-brand-secondary")} />
          </ChromeButton>
          <ChromeButton
            onClick={props.onToggleLater}
            pressed={article.isReadLater}
            aria-label={article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")}
            title={`${article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")} (l)`}
          >
            <Bookmark className={cn("size-5", article.isReadLater && "fill-current text-primary")} />
          </ChromeButton>
          <ChromeButton
            onClick={props.onToggleRead}
            pressed={article.isRead}
            aria-label={article.isRead ? tList("markAsUnread") : tList("markAsRead")}
            title={`${article.isRead ? tList("markAsUnread") : tList("markAsRead")} (m)`}
          >
            {article.isRead ? <Circle className="size-5" /> : <CircleDot className="size-5 text-primary" />}
          </ChromeButton>
          <ChromeButton onClick={props.onShare} aria-label={t("share")} title={t("share")}>
            <Share2 className="size-5" />
          </ChromeButton>
          <ChromeButton onClick={props.onOpenOriginal} disabled={!article.link} aria-label={t("openOriginal")} title={`${t("openOriginal")} (o)`}>
            <ExternalLink className="size-5" />
          </ChromeButton>
        </div>
        {props.typography}
        <div className="hidden wide:contents">{props.more}</div>
      </div>
      <div className="ff-reader-progress" aria-hidden="true" data-testid="reader-progress" />
    </header>
  );
});
