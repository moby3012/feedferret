"use client";

import { useLayoutEffect } from "react";
import Image from "next/image";
import { ExternalLink, MailCheck, ShieldAlert } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { Article } from "@/lib/rss-data";
import { markTitlePainted } from "@/features/reader/perf-marks";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FeedFavicon } from "./feed-favicon";

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
          {article.readTime != null && (
            <>
              <span aria-hidden="true">·</span>
              <span>{t("readTime", { minutes: article.readTime })}</span>
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
        {article.readTime != null && (
          <>
            <span aria-hidden="true">·</span>
            <span>{t("readTime", { minutes: article.readTime })}</span>
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
        <div className="ff-newsletter-confirm" role="note" aria-labelledby="newsletter-confirm-title" data-testid="newsletter-confirm-banner">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
          <div className="min-w-0 flex-1">
            <p id="newsletter-confirm-title" className="text-body-sm font-semibold text-foreground">
              {tNl("confirmTitle")}
            </p>
            <p className="mt-0.5 text-footnote text-muted-foreground">{tNl("confirmBody")}</p>
            {/* A plain link: opened only by the user's click, never fetched or prefetched. */}
            <a
              href={newsletter.confirmationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ size: "sm" }), "mt-2")}
              data-testid="newsletter-confirm-link"
            >
              {tNl("confirmButton")}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
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
