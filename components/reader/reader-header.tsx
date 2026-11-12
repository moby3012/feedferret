"use client";

import { useLayoutEffect, useMemo } from "react";
import Image from "next/image";
import { ExternalLink, MailCheck, ShieldAlert } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { Article } from "@/lib/rss-data";
import { markTitlePainted } from "@/features/reader/perf-marks";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FeedFavicon } from "./feed-favicon";
import { estimateReadMinutes, htmlToPlainText, markdownToPlainText } from "@/lib/article-kind";

/**
 * Feed line → headline → meta → labels → hero (spec §4.7). Painted from the
 * list row alone (no body needed), so it is on screen in the same frame as
 * the tap. Nothing here animates on its own: the reader has one entrance.
 */
export function ReaderHeader({ article, hideImage, onOpenFeed }: { article: Article; hideImage: boolean; onOpenFeed: (feedId: string) => void }) {
  const t = useTranslations("articleReader");
  const tNl = useTranslations("newsletterReader");
  const format = useFormatter();
  const newsletter = article.newsletter ?? null;
  // Newsletter: an e-mail style line, "Von: Name · Datum, Uhrzeit" (sender address on hover).
  const isNewsletter = newsletter !== null || article.feedIsNewsletter === true;
  const senderName = article.author || newsletter?.sender || "";
  const confirmHost = (() => {
    try {
      return newsletter?.confirmationUrl ? new URL(newsletter.confirmationUrl).host : null;
    } catch {
      return null;
    }
  })();
  // Failed sender check: the banner stays, but without the primary call to action.
  const senderFailed = newsletter?.auth === "fail";
  const isAudioOrVideo = article.kind === "audio" || article.kind === "video";
  const fallbackReadMinutes = useMemo(() => {
    if (article.readTime != null) return article.readTime;
    if (!article.content) return null;
    return estimateReadMinutes(
      article.contentFormat === "markdown"
        ? markdownToPlainText(article.content)
        : htmlToPlainText(article.content),
    );
  }, [article.readTime, article.content, article.contentFormat]);
  const readMinutes = isAudioOrVideo ? null : fallbackReadMinutes;

  useLayoutEffect(() => {
    markTitlePainted(article.id);
  }, [article.id]);

  return (
    <header className="ff-reader-header">
      <button
        type="button"
        onClick={() => onOpenFeed(article.feedId)}
        className="ff-reader-feedline hit-slop"
        aria-label={t("showFeed", { feed: article.feedName })}
      >
        <FeedFavicon feedIcon={article.feedIcon} feedName={article.feedName} articleLink={article.link} size={16} newsletter={article.feedIsNewsletter} />
        <span className="truncate">{article.feedName}</span>
      </button>
      <h1 id="article-title" className="ff-reader-title">
        {article.title}
      </h1>
      {isNewsletter ? (
        <p className="ff-reader-meta" data-testid="newsletter-meta">
          {senderName && (
            <>
              <span>
                {tNl("from")}{" "}
                <span className="font-medium text-foreground" title={newsletter?.sender ?? undefined}>
                  {senderName}
                </span>
              </span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <time dateTime={article.publishedAt}>{format.dateTime(new Date(article.publishedAt), { dateStyle: "medium", timeStyle: "short" })}</time>
          {readMinutes != null && (
            <>
              <span aria-hidden="true">·</span>
              <span>{t("readTime", { minutes: readMinutes })}</span>
            </>
          )}
        </p>
      ) : (
      <p className="ff-reader-meta">
        {article.author && (
          <>
            <span className="font-medium text-foreground">{article.author}</span>
            <span aria-hidden="true">·</span>
          </>
        )}
        <time dateTime={article.publishedAt}>{format.dateTime(new Date(article.publishedAt), { dateStyle: "medium" })}</time>
        {readMinutes != null && (
          <>
            <span aria-hidden="true">·</span>
            <span>{t("readTime", { minutes: readMinutes })}</span>
          </>
        )}
      </p>
      )}
      {newsletter?.auth === "fail" && (
        <p className="ff-newsletter-warning" data-testid="newsletter-auth-warning" title={tNl("senderUnverifiedHint")}>
          <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
          <span>{tNl("senderUnverified")}</span>
        </p>
      )}
      {newsletter?.confirmationUrl && (
        <div className="ff-newsletter-confirm" data-sender-failed={senderFailed ? "" : undefined} role="note" aria-labelledby="newsletter-confirm-title" data-testid="newsletter-confirm-banner">
          {senderFailed ? <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden /> : <MailCheck className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />}
          <div className="min-w-0 flex-1">
            <p id="newsletter-confirm-title" className="text-body-sm font-semibold text-foreground">
              {tNl("confirmTitle")}
            </p>
            <p className="mt-0.5 text-footnote text-muted-foreground">{tNl("confirmBody")}</p>
            {senderFailed && <p className="mt-1 text-footnote text-warning">{tNl("senderUnverifiedHint")}</p>}
            {/* A plain link: opened only by the user's click, never fetched or prefetched. */}
            <a
              href={newsletter.confirmationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ size: "sm", variant: senderFailed ? "outline" : "default" }), "mt-2")}
              data-testid="newsletter-confirm-link"
            >
              {tNl("confirmButton")}
              <ExternalLink className="size-3.5" aria-hidden />
              <span className="sr-only"> {tNl("newTab")}</span>
            </a>
            {confirmHost && (
              <p className="mt-1.5 break-all text-footnote text-muted-foreground" data-testid="newsletter-confirm-host">
                {tNl("confirmDestination", { host: confirmHost })}
              </p>
            )}
          </div>
        </div>
      )}
      {!!article.labels?.length && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label={t("labels")}>
          {article.labels.map((item) => (
            <li key={item.label.id} className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-caption text-muted-foreground">
              <span className="size-1.5 rounded-full" style={{ backgroundColor: item.label.color }} />
              {item.label.name}
            </li>
          ))}
        </ul>
      )}
      {article.imageUrl && !hideImage && (
        <figure className="ff-reader-hero">
          <Image src={article.imageUrl} alt="" fill sizes="(max-width: 768px) 100vw, 760px" fetchPriority="high" className="object-cover" />
        </figure>
      )}
    </header>
  );
}
