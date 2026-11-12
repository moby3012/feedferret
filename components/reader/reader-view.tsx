"use client";

import { useCallback, useDeferredValue, useRef } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { Article } from "@/lib/rss-data";
import { cn } from "@/lib/utils";
import { resolveTypography, typographyAttrs, useReaderTypography, type ReaderAccountPrefs } from "@/features/reader/typography/typography";
import type { ReaderNavProps } from "./chrome-button";
import { ReaderHeader } from "./reader-header";
import { useReaderChrome, usePullToNext, useReaderPosition } from "./use-reader-scroll";

// Only the headline path ships with the shell. Lazy: the body (KaTeX +
// highlight.js CSS, AI card; rendered on the server for a deep link `?a=`)
// and the chrome (bar, pill, menus, "Aa" sheet + their CSS; client only, it
// joins one frame after the headline anyway). `ReaderLazyWarmup` mounts both
// once while the shell is idle: a lazy component's first mount always
// suspends, and React throttles that reveal by up to 300 ms.
const loadBody = () => import("./reader-body");
const loadChrome = () => import("./reader-chrome");
const ReaderBody = dynamic(loadBody, { loading: () => null });
const ReaderChrome = dynamic(loadChrome, { ssr: false, loading: () => null });

export function preloadReaderChunks() {
  return Promise.all([loadBody(), loadChrome().then((m) => Promise.all([m.loadMore(), m.loadTypography()]))]);
}

/** Renders nothing; resolves the reader's lazy components (call after `preloadReaderChunks`). */
export function ReaderLazyWarmup() {
  return (
    <>
      <ReaderBody warmup />
      <ReaderChrome warmup />
    </>
  );
}

export interface ReaderViewProps extends ReaderNavProps {
  article: Article;
  /** Position of the article in the bound list (-1: not in it) — gives prev/next their entrance direction. */
  index: number;
  nextTitle: string | null;
  isBodyLoading: boolean;
  /** The body request failed (the header still shows from list data): inline error + retry, never "Kein Inhalt". */
  bodyError?: { retrying: boolean; retry: () => void } | null;
  onBack: () => void;
  onOpenFeed: (feedId: string) => void;
  onToggleStar: (id: string) => void;
  onToggleRead: (id: string) => void;
  onToggleLater: (id: string) => void;
  onFetchFullText?: (id: string) => void;
  isFetchingFullText?: boolean;
  labels: Array<{ id: string; name: string; color: string }>;
  onSetLabels?: (articleId: string, labelIds: string[]) => void;
  /** Account + per-feed fallbacks for the typography the "Aa" sheet leaves unset. */
  typographyFallback: ReaderAccountPrefs;
  hideArticleImage: boolean;
}

type Enter = "open" | "fade" | "next" | "prev";

/**
 * The reader (spec §4.7): hide-on-scroll top bar with progress, the article
 * column (header painted from list data; body lazy), the compact action pill
 * and the tracked pull-past-end indicator. One entrance per open: the pane
 * move on compact (shell.css), a content fade on wide; article → article
 * fades, prev/next adds a short vertical offset (reader.css).
 */
export function ReaderView(props: ReaderViewProps) {
  const { article } = props;
  const t = useTranslations("articleReader");
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const pullRef = useRef<HTMLDivElement | null>(null);

  // Entrance of this article: decided once per article id, during render.
  const enterRef = useRef<{ id: string; index: number; enter: Enter } | null>(null);
  if (enterRef.current?.id !== article.id) {
    const prev = enterRef.current;
    const enter: Enter = !prev
      ? "open"
      : prev.index >= 0 && props.index === prev.index + 1
        ? "next"
        : prev.index >= 0 && props.index === prev.index - 1
          ? "prev"
          : "fade";
    enterRef.current = { id: article.id, index: props.index, enter };
  }
  const enter = enterRef.current.enter;
  const bodyLoading = props.isBodyLoading && !article.content;
  // The tap's own frame paints the headline (and body, when cached); the bar,
  // pill and their lazy menus join one frame later in a background render, so
  // the tap's task stays short (INP). Afterwards this is always true.
  const chromeReady = useDeferredValue(true, false);

  const typography = useReaderTypography();
  const resolved = resolveTypography(typography, props.typographyFallback);
  const {
    className: themeClass,
    style: typoStyle,
    ...typoData
  } = typographyAttrs(resolved) as {
    className?: string;
    style: Record<string, string>;
  } & Record<string, string | undefined>;

  useReaderChrome(rootRef, scrollerRef, barRef, article.id);
  useReaderPosition(scrollerRef, contentRef, article.id);
  const hasNextRef = useRef(props.hasNext);
  hasNextRef.current = props.hasNext;
  const onNextRef = useRef(props.onNext);
  onNextRef.current = props.onNext;
  usePullToNext(scrollerRef, pullRef, hasNextRef, onNextRef);

  const openOriginal = useCallback(() => {
    if (article.link) window.open(article.openLink ?? article.link, "_blank", "noopener,noreferrer");
  }, [article.link, article.openLink]);
  const copyLink = useCallback(async () => {
    if (!article.link) return;
    try {
      await navigator.clipboard.writeText(article.link);
      toast.success(t("linkCopied"));
    } catch {
      /* clipboard denied: nothing to report beyond the missing toast */
    }
  }, [article.link, t]);
  const share = useCallback(async () => {
    if (!article.link) return copyLink();
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: article.title,
          text: article.excerpt,
          url: article.link,
        });
      } catch {
        /* dismissed */
      }
      return;
    }
    await copyLink();
  }, [article.link, article.title, article.excerpt, copyLink]);
  const scrollTop = useCallback(() => scrollerRef.current?.scrollTo({ top: 0 }), []);
  const effectiveSize = useCallback(() => {
    const el = contentRef.current;
    return el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : 17;
  }, []);

  const toggles = {
    onToggleStar: () => props.onToggleStar(article.id),
    onToggleRead: () => props.onToggleRead(article.id),
    onToggleLater: () => props.onToggleLater(article.id),
    onShare: () => void share(),
    onOpenOriginal: openOriginal,
  };
  return (
    <div ref={rootRef} className={cn("ff-reader", themeClass)} data-chrome="shown" style={typoStyle} {...typoData}>
      <div ref={scrollerRef} data-testid="reader-scroller" className="ff-reader-scroller">
        <article key={article.id} ref={contentRef} aria-labelledby="article-title" className="ff-reader-article" data-enter={enter}>
          <ReaderHeader article={article} hideImage={props.hideArticleImage} onOpenFeed={props.onOpenFeed} />
          {bodyLoading && (
            <div data-testid="reader-body-loading" aria-busy="true" className="ff-reader-skeleton">
              <span className="sr-only">{t("loadingBody")}</span>
              <div />
              <div />
              <div />
            </div>
          )}
          {/* Mounted while the body is still loading too: its lazy chunk then
              resolves during the fetch, and the body paints as soon as the
              detail arrives (a first mount on arrival would suspend, and React
              throttles that reveal by ~300 ms). */}
          <ReaderBody
            article={article}
            loading={bodyLoading}
            error={article.content ? null : (props.bodyError ?? null)}
            hideImages={props.hideArticleImage}
            onFetchFullText={props.onFetchFullText}
            isFetchingFullText={props.isFetchingFullText}
            onOpenOriginal={openOriginal}
          />
        </article>
      </div>
      {chromeReady && (
        <ReaderChrome
          article={article}
          barRef={barRef}
          pullRef={pullRef}
          nextTitle={props.nextTitle}
          hasPrevious={props.hasPrevious}
          hasNext={props.hasNext}
          onPrevious={props.onPrevious}
          onNext={props.onNext}
          {...toggles}
          onBack={props.onBack}
          onOpenFeed={props.onOpenFeed}
          labels={props.labels}
          onSetLabels={props.onSetLabels}
          onFetchFullText={props.onFetchFullText}
          isFetchingFullText={props.isFetchingFullText}
          onCopyLink={() => void copyLink()}
          onScrollTop={scrollTop}
          resolved={resolved}
          effectiveSize={effectiveSize}
        />
      )}
    </div>
  );
}
