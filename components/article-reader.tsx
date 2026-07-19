"use client";

import { useTranslations, useFormatter } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import Image from "next/image";
import MarkdownIt from "markdown-it";
import DOMPurify from "isomorphic-dompurify";
import { Article } from "@/lib/rss-data";
import { useAiSettings, useSummarizeArticle } from "@/hooks/use-rss-data";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Star,
  Bookmark,
  Share2,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Circle,
  Copy,
  Sparkles,
  Tag,
  MoreHorizontal,
  ArrowUp,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Lazily-created singleton: only instantiated once markdown-format content actually needs rendering.
let markdownItService: MarkdownIt | null = null;
function getMarkdownItService() {
  if (!markdownItService) {
    markdownItService = new MarkdownIt({ html: false, linkify: true, typographer: true });
  }
  return markdownItService;
}

interface ArticleReaderProps {
  article: Article | null;
  onToggleStar: (articleId: string) => void;
  onToggleReadLater?: (articleId: string) => void;
  onToggleRead?: (articleId: string) => void;
  onFetchFullText?: (articleId: string) => void;
  isFetchingFullText?: boolean;
  labels?: Array<{ id: string; name: string; color: string }>;
  onSetLabels?: (articleId: string, labelIds: string[]) => void;
  onBack?: () => void;
  onOpenFeed?: (feedId: string) => void;
  showBackButton?: boolean;
  onPreviousArticle?: () => void;
  onNextArticle?: () => void;
  hasPreviousArticle?: boolean;
  hasNextArticle?: boolean;
  readerWidth?: "normal" | "wide" | "full";
  readerFontSize?: "small" | "medium" | "large" | "xl";
  hideArticleImage?: boolean;
}

const readerWidthClass: Record<string, string> = {
  normal: "max-w-3xl",
  wide: "max-w-5xl",
  full: "max-w-none",
};

const readerFontSizeClass: Record<string, string> = {
  small: "text-sm leading-relaxed",
  medium: "text-base leading-relaxed",
  large: "text-lg leading-relaxed",
  xl: "text-xl leading-relaxed",
};

function FeedFaviconInReader({ feedIcon, feedName, articleLink, size }: { feedIcon: string; feedName: string; articleLink: string; size: number }) {
  const [imgFailed, setImgFailed] = useState(false);
  const isIconUrl = feedIcon?.startsWith("http") || feedIcon?.startsWith("/");
  let src: string | null = null;
  if (isIconUrl) {
    src = feedIcon;
  } else {
    try {
      const domain = new URL(articleLink).hostname;
      src = `https://www.google.com/s2/favicons?domain=${domain}&sz=${size * 2}`;
    } catch {}
  }
  if (src && !imgFailed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={feedName} width={size} height={size} className="object-contain rounded-sm" style={{ width: size, height: size }} onError={() => setImgFailed(true)} />;
  }
  return <span style={{ fontSize: size * 0.8, lineHeight: 1 }}>{feedIcon || "📰"}</span>;
}

export function ArticleReader({
  article,
  onToggleStar,
  onToggleReadLater,
  onToggleRead,
  onFetchFullText,
  isFetchingFullText,
  labels = [],
  onSetLabels,
  onBack,
  onOpenFeed,
  showBackButton,
  onPreviousArticle,
  onNextArticle,
  hasPreviousArticle,
  hasNextArticle,
  readerWidth = "normal",
  readerFontSize = "medium",
  hideArticleImage = false,
}: ArticleReaderProps) {
  const t = useTranslations("articleReader");
  const tList = useTranslations("articleList");
  const format = useFormatter();
  const rootRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // Track navigation direction for page-turn animation
  const navDirRef = useRef<"next" | "prev" | null>(null);
  const [articleAnimClass, setArticleAnimClass] = useState("animate-fade-in");

  const handleNextArticle = useCallback(() => {
    navDirRef.current = "next";
    onNextArticle?.();
  }, [onNextArticle]);

  const handlePreviousArticle = useCallback(() => {
    navDirRef.current = "prev";
    onPreviousArticle?.();
  }, [onPreviousArticle]);

  const handleTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    if (!touchStartRef.current) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    touchStartRef.current = null;
    if (Math.abs(dx) < 72 || Math.abs(dy) > Math.abs(dx) * 0.75) return;
    if (dx > 0) onBack?.();
    else if (dx < 0 && article?.link) window.open(article.link, "_blank", "noopener,noreferrer");
  };
  const { data: aiSettings } = useAiSettings();
  const aiSummaryEnabled = Boolean(aiSettings?.provider);
  const [localSummary, setLocalSummary] = useState<string | null>(null);
  const [summarizeFailed, setSummarizeFailed] = useState(false);
  const summarize = useSummarizeArticle();

  useEffect(() => {
    setLocalSummary(null);
    setSummarizeFailed(false);
  }, [article?.id]);

  // Content is stored either as sanitized HTML or as Markdown (M1); render
  // Markdown to HTML client-side and sanitize the result before injecting it.
  const renderedHtml = useMemo(() => {
    if (!article?.content) return "";
    if (article.contentFormat === "markdown") {
      const rawHtml = getMarkdownItService().render(article.content);
      return DOMPurify.sanitize(rawHtml, { ADD_ATTR: ["target", "rel"] });
    }
    return article.content; // already-sanitized HTML (legacy + html mode)
  }, [article]);

  useEffect(() => {
    if (!article?.id) return;

    const dir = navDirRef.current;
    navDirRef.current = null;
    if (dir === "next") setArticleAnimClass("animate-article-enter-bottom");
    else if (dir === "prev") setArticleAnimClass("animate-article-enter-top");
    else setArticleAnimClass("animate-fade-in");

    const animationFrame = window.requestAnimationFrame(() => {
      const viewport = rootRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      );
      viewport?.scrollTo({ top: 0, left: 0 });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [article?.id]);

  // Overscroll past top → previous article, past bottom → next article (#14)
  useEffect(() => {
    if (!article?.id) return;
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;

    let accum = 0;
    let lastFire = 0;
    const COOLDOWN = 1200;
    const THRESHOLD = 280;

    const fire = (dir: 1 | -1) => {
      const now = Date.now();
      if (now - lastFire < COOLDOWN) return;
      lastFire = now;
      accum = 0;
      if (dir === 1 && hasNextArticle) handleNextArticle();
      else if (dir === -1 && hasPreviousArticle) handlePreviousArticle();
    };

    const handleWheel = (e: WheelEvent) => {
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const canScroll = scrollHeight > clientHeight + 8;
      const atBottom = !canScroll || scrollHeight - (scrollTop + clientHeight) < 8;
      const atTop = scrollTop < 4;
      if (atBottom && e.deltaY > 0) {
        accum += e.deltaY;
        if (accum > THRESHOLD) fire(1);
      } else if (atTop && e.deltaY < 0) {
        accum += Math.abs(e.deltaY);
        if (accum > THRESHOLD) fire(-1);
      } else {
        accum = 0;
      }
    };

    let touchStartY = 0;
    let touchAccum = 0;
    const handleEdgeTouchStart = (e: globalThis.TouchEvent) => {
      if (e.touches.length !== 1) return;
      touchStartY = e.touches[0].clientY;
      touchAccum = 0;
    };
    const handleEdgeTouchMove = (e: globalThis.TouchEvent) => {
      if (e.touches.length !== 1) return;
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const canScroll = scrollHeight > clientHeight + 8;
      const atBottom = !canScroll || scrollHeight - (scrollTop + clientHeight) < 8;
      const atTop = scrollTop < 4;
      const dy = touchStartY - e.touches[0].clientY;
      if (atBottom && dy > 0) {
        touchAccum = dy;
        if (touchAccum > 140) fire(1);
      } else if (atTop && dy < 0) {
        touchAccum = Math.abs(dy);
        if (touchAccum > 140) fire(-1);
      }
    };

    viewport.addEventListener("wheel", handleWheel, { passive: true });
    viewport.addEventListener("touchstart", handleEdgeTouchStart, { passive: true });
    viewport.addEventListener("touchmove", handleEdgeTouchMove, { passive: true });
    return () => {
      viewport.removeEventListener("wheel", handleWheel);
      viewport.removeEventListener("touchstart", handleEdgeTouchStart);
      viewport.removeEventListener("touchmove", handleEdgeTouchMove);
    };
  }, [article?.id, hasNextArticle, hasPreviousArticle, handleNextArticle, handlePreviousArticle]);

  if (!article) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background animate-fade-in">
        <div className="text-center max-w-md px-8">
          <div className="w-24 h-24 rounded-3xl bg-muted flex items-center justify-center mx-auto mb-8 shadow-lg overflow-hidden p-6 border border-border/50">
            <Image
              src="/logo.svg"
              alt="FeedFerret Logo"
              width={48}
              height={48}
              className="w-12 h-12 invert dark:invert-0"
            />
          </div>
          <h2 className="text-2xl font-semibold text-foreground mb-3 text-balance">
            {t("selectArticle")}
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed">
            {t("selectArticleDescription")}
          </p>
        </div>
      </div>
    );
  }

  const openOriginal = () => {
    if (!article.link) return;
    window.open(article.link, "_blank", "noopener,noreferrer");
  };

  const copyLink = async () => {
    if (!article.link) return;
    await navigator.clipboard.writeText(article.link);
    toast.success(t("linkCopied"));
  };

  const shareArticle = async () => {
    if (!article.link) return copyLink();
    if (navigator.share) {
      await navigator.share({
        title: article.title,
        text: article.excerpt,
        url: article.link,
      });
      return;
    }
    await copyLink();
  };

  const articleLabelIds = article.labels?.map((item) => item.label.id) || [];


  const scrollReaderToTop = () => {
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    viewport?.scrollTo({ top: 0, left: 0, behavior: "smooth" });
  };

  return (
    <div
      ref={rootRef}
      className="flex-1 flex flex-col bg-background/75 backdrop-blur-xl animate-fade-in"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Reader Header */}
      <header className="flex items-center justify-between px-4 sm:px-6 pt-[calc(0.75rem_+_env(safe-area-inset-top))] pb-3 border-b border-border/60 bg-background/80 backdrop-blur-2xl sticky top-0 z-10">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          {showBackButton && (
            <Button
              variant="ghost"
              size="icon"
              className="w-11 h-11 rounded-xl hover:bg-muted transition-all duration-200 hover:scale-105 active:scale-95"
              onClick={onBack}
              aria-label={t("back")}
            >
              <ChevronLeft className="w-5 h-5" />
            </Button>
          )}
          <button
            type="button"
            onClick={() => onOpenFeed?.(article.feedId)}
            className="flex min-w-0 items-center gap-3 rounded-2xl px-2 py-1.5 text-start transition-colors hover:bg-muted/70 active:scale-[0.99]"
            aria-label={`Show all articles from ${article.feedName}`}
          >
            <div className="w-6 h-6 rounded-md overflow-hidden bg-muted flex items-center justify-center shrink-0">
              <FeedFaviconInReader feedIcon={article.feedIcon} feedName={article.feedName} articleLink={article.link} size={24} />
            </div>
            <span className="truncate text-sm font-semibold text-foreground">
              {article.feedName}
            </span>
          </button>
        </div>
        <div className="hidden lg:flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
            onClick={() => onToggleStar(article.id)}
            aria-label={article.isStarred ? tList("removeStar") : tList("star")}
            aria-pressed={article.isStarred}
            title={article.isStarred ? tList("removeStar") : tList("star")}
          >
            <Star
              className={cn(
                "w-4 h-4 transition-all duration-300",
                article.isStarred
                  ? "text-brand-secondary fill-brand-secondary scale-110"
                  : "text-muted-foreground hover:text-brand-secondary",
              )}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95",
              article.isReadLater && "bg-accent",
            )}
            onClick={() => onToggleReadLater?.(article.id)}
            aria-label={article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")}
            aria-pressed={article.isReadLater}
            title={article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")}
          >
            <Bookmark
              className={cn(
                "w-4 h-4 transition-all duration-300",
                article.isReadLater
                  ? "text-accent-foreground fill-accent-foreground scale-110"
                  : "text-muted-foreground hover:text-accent",
              )}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
            onClick={() => onToggleRead?.(article.id)}
            aria-label={article.isRead ? tList("markAsUnread") : tList("markAsRead")}
            aria-pressed={article.isRead}
            title={article.isRead ? tList("markAsUnread") : tList("markAsRead")}
          >
            {article.isRead ? (
              <Circle className="w-4 h-4 text-muted-foreground" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-muted-foreground" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
            onClick={shareArticle}
            aria-label={t("share")}
            title={t("share")}
          >
            <Share2 className="w-4 h-4 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
            onClick={openOriginal}
            disabled={!article.link}
            aria-label={t("openOriginal")}
            title={t("openOriginal")}
          >
            <ExternalLink className="w-4 h-4 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
            onClick={copyLink}
            disabled={!article.link}
            aria-label={t("copyLink")}
            title={t("copyLink")}
          >
            <Copy className="w-4 h-4 text-muted-foreground" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
                aria-label={t("labels")}
                title={t("labels")}
              >
                <Tag className="w-4 h-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-56 rounded-2xl p-2"
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("labels")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {labels.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">
                  {t("noLabels")}
                </div>
              ) : (
                labels.map((label) => {
                  const checked = articleLabelIds.includes(label.id);
                  return (
                    <DropdownMenuCheckboxItem
                      key={label.id}
                      checked={checked}
                      onCheckedChange={(nextChecked) => {
                        const nextIds = nextChecked
                          ? Array.from(new Set([...articleLabelIds, label.id]))
                          : articleLabelIds.filter((id) => id !== label.id);
                        onSetLabels?.(article.id, nextIds);
                      }}
                      className="rounded-xl"
                    >
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: label.color }}
                      />
                      {label.name}
                    </DropdownMenuCheckboxItem>
                  );
                })
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Article Content */}
      <ScrollArea className={cn("flex-1 overflow-hidden min-h-0", articleAnimClass)}>
        <article aria-labelledby="article-title" className={cn("reader-page mx-auto w-full min-w-0 max-w-full overflow-hidden px-5 pt-8 pb-[calc(4rem_+_env(safe-area-inset-bottom)_+_1.5rem)] sm:px-8 sm:pt-12 lg:pb-12", readerWidthClass[readerWidth] ?? "max-w-3xl")}>
          {/* Article Header */}
          <header className="mb-10 animate-fade-in-up">
            <h1
              id="article-title"
              onClick={() => {
                // Tapping/clicking the headline opens the original article — but
                // don't hijack a click that was really the user selecting title text.
                if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
                openOriginal();
              }}
              title={article.link ? t("openOriginal") : undefined}
              className={cn(
                "text-2xl sm:text-4xl lg:text-[2.85rem] font-semibold text-foreground leading-[1.08] sm:leading-[1.04] mb-5 text-balance tracking-[-0.04em] break-words [overflow-wrap:anywhere]",
                article.link && "cursor-pointer transition-colors hover:text-link",
              )}
            >
              {article.title}
            </h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
              <address className="not-italic font-medium text-foreground" rel="author">
                {article.author}
              </address>
              <span aria-hidden="true" className="text-muted-foreground/40">·</span>
              <time dateTime={article.publishedAt}>{format.dateTime(new Date(article.publishedAt), { dateStyle: "medium" })}</time>
              <span aria-hidden="true" className="text-muted-foreground/40">·</span>
              <span>{article.readTime}</span>
            </div>
            {!!article.labels?.length && (
              <div className="mt-5 flex flex-wrap gap-2">
                {article.labels.map((item) => (
                  <span
                    key={item.label.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: item.label.color }}
                    />
                    {item.label.name}
                  </span>
                ))}
              </div>
            )}
          </header>

          {/* AI Summary card */}
          {aiSummaryEnabled && (() => {
            const summary = localSummary ?? article.aiSummary;
            return (
              <div className="mb-8 rounded-2xl border border-border/60 border-s-2 border-s-brand bg-muted/40 px-5 py-4 animate-fade-in-up">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    <Sparkles className="h-3.5 w-3.5 text-brand" />
                    {t("aiSummary")}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs rounded-xl text-muted-foreground hover:text-foreground"
                    disabled={summarize.isPending}
                    onClick={async () => {
                      setSummarizeFailed(false);
                      try {
                        const result = await summarize.mutateAsync(article.id);
                        setLocalSummary(result.summary);
                      } catch {
                        // Error toast is shown by useSummarizeArticle's onError;
                        // here we just track state for the inline retry hint.
                        setSummarizeFailed(true);
                      }
                    }}
                  >
                    {summarize.isPending ? (
                      <span className="animate-pulse">{t("summarizing")}</span>
                    ) : summary ? (
                      t("regenerate")
                    ) : (
                      t("summarize")
                    )}
                  </Button>
                </div>
                {summary ? (
                  <p className="mt-2 text-sm leading-relaxed text-foreground/80">{summary}</p>
                ) : summarizeFailed ? (
                  <p className="mt-2 text-sm text-destructive">
                    {t("summarizeFailedInline")}
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground italic">
                    {t("aiSummaryHint")}
                  </p>
                )}
              </div>
            );
          })()}

          {/* Hero Image */}
          {article.imageUrl && !hideArticleImage && (
            <figure className="mb-12 -mx-6 sm:mx-0 animate-scale-in">
              <div className="aspect-[16/9] sm:rounded-2xl overflow-hidden bg-muted shadow-2xl shadow-black/10 relative">
                <Image
                  src={article.imageUrl || "/placeholder.svg"}
                  alt=""
                  fill
                  sizes="(max-width: 640px) 100vw, 800px"
                  className="object-cover transition-transform duration-500 hover:scale-105"
                />
              </div>
            </figure>
          )}

          {/* Article Body */}
          {article.content && article.content.trim().length > 0 ? (
            <div
              className={`animate-fade-in-up animation-delay-200 article-content min-w-0 max-w-full overflow-hidden ${readerFontSizeClass[readerFontSize] ?? readerFontSizeClass.medium}`}
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          ) : (
            <div className="animate-fade-in-up animation-delay-200 rounded-3xl border border-border/70 bg-card/70 p-6 text-center">
              <p className="text-sm font-medium text-foreground mb-1">{t("noContent")}</p>
              <p className="text-sm text-muted-foreground mb-4">
                {t("noContentDescription")}
              </p>
              {article.link && (
                <Button onClick={openOriginal} variant="outline" className="rounded-xl">
                  <ExternalLink className="w-4 h-4 me-2" />
                  {t("openOriginal")}
                </Button>
              )}
            </div>
          )}

          {article.content && article.link && article.content.length < 900 && (
            <div className="mt-10 rounded-3xl border border-border/70 bg-card/70 p-5 shadow-sm">
              <p className="text-sm text-muted-foreground mb-4">
                {t("noContentDescription")}
              </p>
              {isFetchingFullText && (
                <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("fetchingFullTextStatus")}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => onFetchFullText?.(article.id)}
                  disabled={isFetchingFullText}
                  className="rounded-xl"
                >
                  {isFetchingFullText ? (
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4 me-2" />
                  )}
                  {isFetchingFullText ? t("fetching") : t("fetchFullText")}
                </Button>
                <Button onClick={openOriginal} variant="outline" className="rounded-xl">
                  <ExternalLink className="w-4 h-4 me-2" />
                  {t("openOriginal")}
                </Button>
              </div>
            </div>
          )}

          {/* Article Footer */}
          <footer className="mt-16 pt-8 border-t border-border animate-fade-in-up animation-delay-300">
            <button
              type="button"
              onClick={() => onOpenFeed?.(article.feedId)}
              aria-label={`View all articles from ${article.feedName}`}
              className="flex w-full items-center gap-4 rounded-3xl p-2 text-start transition-colors hover:bg-muted/50 active:scale-[0.99]"
            >
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center shadow-lg overflow-hidden">
                <FeedFaviconInReader feedIcon={article.feedIcon} feedName={article.feedName} articleLink={article.link} size={36} />
              </div>
              <div>
                <p className="text-lg font-semibold text-foreground">
                  {article.feedName}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("viewAllFromFeed")}
                </p>
              </div>
            </button>
          </footer>
        </article>
      </ScrollArea>

      <nav className="fixed inset-x-0 bottom-0 z-[60] bg-background/95 backdrop-blur-xl pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden">
        <div className="flex h-16 items-center rounded-[2rem] border border-border/70 bg-background/90 px-1 shadow-2xl shadow-black/20 backdrop-blur-2xl supports-[backdrop-filter]:bg-background/75">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 flex-1 rounded-2xl text-muted-foreground active:scale-95"
            onClick={hasPreviousArticle ? handlePreviousArticle : onBack}
            aria-label={hasPreviousArticle ? t("previousArticle") : t("backToList")}
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-11 flex-1 rounded-2xl active:scale-95",
              article.isStarred ? "text-brand-secondary" : "text-muted-foreground",
            )}
            onClick={() => onToggleStar(article.id)}
            aria-label={article.isStarred ? tList("removeStar") : tList("star")}
          >
            <Star className={cn("h-5 w-5", article.isStarred && "fill-brand-secondary")} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={cn(
              "h-11 flex-1 rounded-2xl active:scale-95 transition-all duration-200",
              article.isRead ? "bg-muted/70 text-foreground" : "bg-accent text-accent-foreground shadow-lg shadow-accent/20",
            )}
            onClick={() => onToggleRead?.(article.id)}
            aria-pressed={article.isRead}
            aria-label={article.isRead ? tList("markAsUnread") : tList("markAsRead")}
          >
            {article.isRead ? <Circle className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-11 flex-1 rounded-2xl active:scale-95",
              article.isReadLater ? "bg-accent text-accent-foreground" : "text-muted-foreground",
            )}
            onClick={() => onToggleReadLater?.(article.id)}
            aria-label={article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")}
          >
            <Bookmark className={cn("h-5 w-5", article.isReadLater && "fill-accent-foreground")} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 flex-1 rounded-2xl text-muted-foreground active:scale-95"
                aria-label={t("moreActions")}
              >
                <MoreHorizontal className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={12}
              className="mb-2 w-64 rounded-3xl p-2"
            >
              <DropdownMenuItem className="rounded-2xl py-3" onClick={scrollReaderToTop}>
                <ArrowUp className="me-3 h-4 w-4" />
                {t("scrollToTop")}
              </DropdownMenuItem>
              <DropdownMenuItem className="rounded-2xl py-3" onClick={shareArticle}>
                <Share2 className="me-3 h-4 w-4" />
                {t("share")}
              </DropdownMenuItem>
              <DropdownMenuItem className="rounded-2xl py-3" onClick={openOriginal} disabled={!article.link}>
                <ExternalLink className="me-3 h-4 w-4" />
                {t("openOriginal")}
              </DropdownMenuItem>
              <DropdownMenuItem className="rounded-2xl py-3" onClick={copyLink} disabled={!article.link}>
                <Copy className="me-3 h-4 w-4" />
                {t("copyLink")}
              </DropdownMenuItem>
              {article.link && (!article.content || article.content.length < 900) && (
                <DropdownMenuItem
                  className="rounded-2xl py-3"
                  onClick={() => onFetchFullText?.(article.id)}
                  disabled={isFetchingFullText}
                >
                  <Sparkles className="me-3 h-4 w-4" />
                  {isFetchingFullText ? t("fetching") : t("fetchFullText")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator className="my-2" />
              <DropdownMenuLabel className="text-xs text-muted-foreground">{t("labels")}</DropdownMenuLabel>
              {labels.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">{t("noLabels")}</div>
              ) : (
                labels.map((label) => {
                  const checked = articleLabelIds.includes(label.id);
                  return (
                    <DropdownMenuCheckboxItem
                      key={label.id}
                      checked={checked}
                      onCheckedChange={(nextChecked) => {
                        const nextIds = nextChecked
                          ? Array.from(new Set([...articleLabelIds, label.id]))
                          : articleLabelIds.filter((id) => id !== label.id);
                        onSetLabels?.(article.id, nextIds);
                      }}
                      className="rounded-2xl py-2.5"
                    >
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: label.color }}
                      />
                      {label.name}
                    </DropdownMenuCheckboxItem>
                  );
                })
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 flex-1 rounded-2xl text-muted-foreground active:scale-95"
            onClick={handleNextArticle}
            disabled={!hasNextArticle}
            aria-label={t("nextArticle")}
          >
            <ChevronRight className="h-5 w-5" />
          </Button>
        </div>
      </nav>
    </div>
  );
}
