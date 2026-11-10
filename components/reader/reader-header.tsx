"use client";

import { useLayoutEffect } from "react";
import Image from "next/image";
import { useFormatter, useTranslations } from "next-intl";
import type { Article } from "@/lib/rss-data";
import { markTitlePainted } from "@/features/reader/perf-marks";
import { FeedFavicon } from "./feed-favicon";

/**
 * Feed line → headline → meta → labels → hero (spec §4.7). Painted from the
 * list row alone (no body needed), so it is on screen in the same frame as
 * the tap. Nothing here animates on its own: the reader has one entrance.
 */
export function ReaderHeader({ article, hideImage, onOpenFeed }: { article: Article; hideImage: boolean; onOpenFeed: (feedId: string) => void }) {
  const t = useTranslations("articleReader");
  const format = useFormatter();

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
        <FeedFavicon feedIcon={article.feedIcon} feedName={article.feedName} articleLink={article.link} size={16} />
        <span className="truncate">{article.feedName}</span>
      </button>
      <h1 id="article-title" className="ff-reader-title">
        {article.title}
      </h1>
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
