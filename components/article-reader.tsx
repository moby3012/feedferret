"use client";

import { useTranslations, useFormatter } from "next-intl";
import { useCallback, useEffect, useRef, useState, type TouchEvent } from "react";
import Image from "next/image";
import { Article } from "@/lib/rss-data";
import { startsAtSystemEdge, startsInPannableContent } from "@/lib/gesture-guards";
import { useAiSettings, useSummarizeArticle, useExportSettings, useBuildObsidianExportLink, useExportArticleToWallabag } from "@/hooks/use-rss-data";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
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
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ReaderEmptyState } from "@/components/reader/reader-empty";
// KaTeX math (fonts + layout CSS; no colours of its own — it inherits
// .article-content's theme-aware text colour) and the syntax-highlighting
// theme of fenced code blocks (one dark theme: prose code blocks have a fixed
// dark background in both site themes). Imported here, not in the root
// layout: they ship with the lazily loaded reader chunk, off the critical path.
import "katex/dist/katex.min.css";
import "highlight.js/styles/atom-one-dark.css";

interface ArticleReaderProps {
  article: Article | null;
  /** The body (article detail) is still being fetched: show a skeleton instead of "no content". */
  isBodyLoading?: boolean;
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
    return <img src={src} alt={feedName} width={size} height={size} referrerPolicy="no-referrer" className="object-contain rounded-sm" style={{ width: size, height: size }} onError={() => setImgFailed(true)} />;
  }
  return <span style={{ fontSize: size * 0.8, lineHeight: 1 }}>{feedIcon || "📰"}</span>;
}

export function ArticleReader({
  article,
  isBodyLoading = false,
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

  // Swipe right → back (mobile). There is deliberately no left-swipe action:
  // opening the original is only ever an explicit button / the `o` shortcut.
  // Touches that start in code blocks, tables or other horizontal scrollers
  // are the user panning content, not navigating. Touches starting in the
  // OS edge band belong to the system back gesture (iOS edge-swipe): handling
  // them too would go back twice.
  const handleTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];
    touchStartRef.current =
      startsInPannableContent(e.target, rootRef.current) || startsAtSystemEdge(touch.clientX, window.innerWidth)
        ? null
        : { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    if (!touchStartRef.current) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    touchStartRef.current = null;
    if (Math.abs(dx) < 72 || Math.abs(dy) > Math.abs(dx) * 0.75) return;
    if (dx > 0) onBack?.();
  };
  const { data: aiSettings } = useAiSettings();
  const aiSummaryEnabled = Boolean(aiSettings?.provider);
  const [localSummary, setLocalSummary] = useState<string | null>(null);
  // false | "error" (provider failed) | "budget" (daily token cap) | "ai_off" (cap 0)
  const [summarizeFailed, setSummarizeFailed] = useState<false | "error" | "budget" | "ai_off">(false);
  const summarize = useSummarizeArticle();

  // F5: export / "send to" destinations — hidden entirely unless the user has
  // configured at least one, mirroring the aiSummaryEnabled gating above.
  const { data: exportSettings } = useExportSettings();
  const buildObsidianLink = useBuildObsidianExportLink();
  const exportToWallabag = useExportArticleToWallabag();
  const canExport = Boolean(exportSettings?.obsidianConfigured || exportSettings?.wallabagConfigured);

  const sendToObsidian = useCallback(async () => {
    if (!article) return;
    const result = await buildObsidianLink.mutateAsync(article.id);
    if (!result.success || !result.url) {
      toast.error(result.error || t("sendToFailed"));
      return;
    }
    // Hands off to the OS/Obsidian app — no data leaves this server.
    window.location.href = result.url;
    toast.success(t("sendToObsidianSuccess"));
  }, [article, buildObsidianLink, t]);

  const sendToWallabagHandler = useCallback(async () => {
    if (!article) return;
    const result = await exportToWallabag.mutateAsync(article.id);
    if (!result.success) {
      toast.error(result.error || t("sendToFailed"));
      return;
    }
    toast.success(t("sendToWallabagSuccess"));
  }, [article, exportToWallabag, t]);

  useEffect(() => {
    setLocalSummary(null);
    setSummarizeFailed(false);
  }, [article?.id]);

  // `content` is render-ready HTML from GET /api/app/articles/:id: stored HTML
  // (sanitized at sync) or Markdown rendered + sanitized on the server with the
  // same sanitizer REST/GReader/Fever use. Nothing is parsed or sanitized here.
  const renderedHtml = article?.content ?? "";

  useEffect(() => {
    if (!article?.id) return;

    const dir = navDirRef.current;
    navDirRef.current = null;
    if (dir === "next") setArticleAnimClass("animate-article-enter-bottom");
    else if (dir === "prev") setArticleAnimClass("animate-article-enter-top");
    else setArticleAnimClass("animate-fade-in");

    const animationFrame = window.requestAnimationFrame(() => {
      const viewport = rootRef.current?.querySelector<HTMLElement>(
        '[data-testid="reader-scroller"]',
      );
      viewport?.scrollTo({ top: 0, left: 0 });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [article?.id]);

  // Overscroll past top → previous article, past bottom → next article (#14)
  useEffect(() => {
    if (!article?.id) return;
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      '[data-testid="reader-scroller"]',
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

  if (!article) return <ReaderEmptyState />;

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
      '[data-testid="reader-scroller"]',
    );
    viewport?.scrollTo({ top: 0, left: 0, behavior: "smooth" });
  };

  return (
    <div
      ref={rootRef}
      // min-w-0: this is a flex item in its parent's row (the fixed mobile
      // reader wrapper in app/page.tsx, and the desktop split view). Without
      // it, the browser's flex "automatic minimum size" lets any unbreakable
      // content anywhere inside (however deeply nested) inflate this whole
      // panel past the viewport — every truncate/overflow-hidden rule further
      // down the tree then operates on an already-too-wide box, so it clips
      // relative to that, not to the real screen edge. This is the actual
      // fix for symptoms that look like "several unrelated elements are all
      // cut off at once" — that's this exact failure mode, not a coincidence.
      // contain:layout is belt-and-suspenders on top of min-w-0: it's the
      // same guarantee already used on .article-content (see globals.css) —
      // by spec it makes this box's own size independent of its content
      // entirely, so no engine-specific automatic-minimum-size bug (seen on
      // iOS Safari, not reproducible in Chromium) can inflate it no matter
      // what renders inside, regardless of whether every descendant remembers
      // its own min-w-0/overflow-hidden correctly.
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background/75 backdrop-blur-bar animate-fade-in [contain:layout]"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Reader Header */}
      <header className="flex min-w-0 items-center justify-between px-4 sm:px-6 pt-[calc(0.75rem_+_var(--safe-t))] pb-3 border-b border-border/60 bg-background/80 backdrop-blur-bar sticky top-0 z-(--z-sticky) [contain:layout]">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          {showBackButton && (
            <Button
              variant="ghost"
              size="icon"
              className="w-11 h-11 rounded-xl hover:bg-muted transition-all duration-(--dur-base) hover:scale-105 active:scale-95"
              onClick={onBack}
              aria-label={t("back")}
            >
              <ChevronLeft className="w-5 h-5" />
            </Button>
          )}
          <button
            type="button"
            onClick={() => onOpenFeed?.(article.feedId)}
            className="hit-slop flex min-w-0 items-center gap-3 overflow-hidden rounded-2xl px-2 py-1.5 text-start transition-colors hover:bg-muted/70 active:scale-[0.99]"
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
        <div className="hidden wide:flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-(--dur-base) hover:scale-105 active:scale-95"
            onClick={() => onToggleStar(article.id)}
            aria-label={article.isStarred ? tList("removeStar") : tList("star")}
            aria-pressed={article.isStarred}
            title={article.isStarred ? tList("removeStar") : tList("star")}
          >
            <Star
              className={cn(
                "w-4 h-4 transition-all duration-(--dur-slow)",
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
              "w-10 h-10 rounded-xl transition-all duration-(--dur-base) hover:scale-105 active:scale-95",
              article.isReadLater && "bg-accent",
            )}
            onClick={() => onToggleReadLater?.(article.id)}
            aria-label={article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")}
            aria-pressed={article.isReadLater}
            title={article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")}
          >
            <Bookmark
              className={cn(
                "w-4 h-4 transition-all duration-(--dur-slow)",
                article.isReadLater
                  ? "text-accent-foreground fill-accent-foreground scale-110"
                  : "text-muted-foreground hover:text-accent",
              )}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-(--dur-base) hover:scale-105 active:scale-95"
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
            className="w-10 h-10 rounded-xl transition-all duration-(--dur-base) hover:scale-105 active:scale-95"
            onClick={shareArticle}
            aria-label={t("share")}
            title={t("share")}
          >
            <Share2 className="w-4 h-4 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-(--dur-base) hover:scale-105 active:scale-95"
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
            className="w-10 h-10 rounded-xl transition-all duration-(--dur-base) hover:scale-105 active:scale-95"
            onClick={copyLink}
            disabled={!article.link}
            aria-label={t("copyLink")}
            title={t("copyLink")}
          >
            <Copy className="w-4 h-4 text-muted-foreground" />
          </Button>
          {/* F5: "Send to" export destinations — hidden entirely unless the
              user has configured at least one (Obsidian vault / Wallabag). */}
          {canExport && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-10 h-10 rounded-xl transition-all duration-(--dur-base) hover:scale-105 active:scale-95"
                  aria-label={t("sendTo")}
                  title={t("sendTo")}
                >
                  <Send className="w-4 h-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48 rounded-2xl p-2">
                <DropdownMenuLabel className="text-xs text-muted-foreground">{t("sendTo")}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {exportSettings?.obsidianConfigured && (
                  <DropdownMenuItem className="rounded-xl" onClick={sendToObsidian} disabled={buildObsidianLink.isPending}>
                    {t("sendToObsidian")}
                  </DropdownMenuItem>
                )}
                {exportSettings?.wallabagConfigured && (
                  <DropdownMenuItem className="rounded-xl" onClick={sendToWallabagHandler} disabled={exportToWallabag.isPending}>
                    {t("sendToWallabag")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Desktop parity for the mobile more-menu's "Fetch full text": the
              bottom action bar hosting that menu is wide:hidden, so without this
              a desktop reader showing a teaser article has no way to trigger a
              manual full-text fetch at all. */}
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-(--dur-base) hover:scale-105 active:scale-95"
            onClick={() => onFetchFullText?.(article.id)}
            disabled={!article.link || isFetchingFullText}
            aria-label={isFetchingFullText ? t("fetching") : t("fetchFullText")}
            title={isFetchingFullText ? t("fetching") : t("fetchFullText")}
          >
            {isFetchingFullText ? (
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            ) : (
              <Sparkles className="w-4 h-4 text-muted-foreground" />
            )}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="w-10 h-10 rounded-xl transition-all duration-(--dur-base) hover:scale-105 active:scale-95"
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
      <div data-testid="reader-scroller" className={cn("flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain", articleAnimClass)}>
        <article aria-labelledby="article-title" className={cn("reader-page mx-auto w-full min-w-0 max-w-full overflow-hidden px-5 pt-8 pb-[calc(4rem_+_var(--safe-b)_+_1.5rem)] sm:px-8 sm:pt-12 wide:pb-12", readerWidthClass[readerWidth] ?? "max-w-3xl")}>
          {/* Article Header */}
          <header className="mb-10 animate-fade-in-up">
            <h1
              id="article-title"
              className={cn(
                // No text-balance: Safari has shipped it with real interop bugs
                // where a balanced heading stops respecting overflow-wrap on long
                // headlines, letting them overflow instead of wrapping — not worth
                // the purely cosmetic line-balancing on a reader headline.
                "text-display font-semibold text-foreground leading-[1.08] sm:leading-[1.04] mb-5 tracking-title break-words [overflow-wrap:anywhere]",
              )}
            >
              {article.title}
            </h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
              {article.author && (
                <>
                  <address className="not-italic font-medium text-foreground" rel="author">
                    {article.author}
                  </address>
                  <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                </>
              )}
              <time dateTime={article.publishedAt}>{format.dateTime(new Date(article.publishedAt), { dateStyle: "medium" })}</time>
              {article.readTime != null && (
                <>
                  <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                  <span>{t("readTime", { minutes: article.readTime })}</span>
                </>
              )}
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
              <div className="mb-8 min-w-0 overflow-hidden rounded-2xl border border-border/60 border-s-2 border-s-brand bg-muted/40 px-5 py-4 animate-fade-in-up">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-brand" />
                    <span className="truncate">{t("aiSummary")}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 whitespace-nowrap px-2 text-xs rounded-xl text-muted-foreground hover:text-foreground"
                    disabled={summarize.isPending}
                    onClick={async () => {
                      setSummarizeFailed(false);
                      try {
                        const result = await summarize.mutateAsync(article.id);
                        if (result.error) setSummarizeFailed(result.error);
                        else setLocalSummary(result.summary);
                      } catch {
                        // Error toast is shown by useSummarizeArticle's onError;
                        // here we just track state for the inline retry hint.
                        setSummarizeFailed("error");
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
                  <p className="mt-2 text-sm text-destructive" role="status">
                    {summarizeFailed === "budget" ? t("summarizeBudget") : summarizeFailed === "ai_off" ? t("summarizeAiOff") : t("summarizeFailedInline")}
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
              <div className="aspect-[16/9] sm:rounded-2xl overflow-hidden bg-muted shadow-overlay relative">
                <Image
                  src={article.imageUrl || "/placeholder.svg"}
                  alt=""
                  fill
                  sizes="(max-width: 640px) 100vw, 800px"
                  className="object-cover transition-transform duration-(--dur-slow) hover:scale-105"
                />
              </div>
            </figure>
          )}

          {/* Article Body */}
          {isBodyLoading && !article.content ? (
            <div data-testid="reader-body-loading" aria-busy="true" className="space-y-3 animate-pulse">
              <span className="sr-only">{t("loadingBody")}</span>
              <div className="h-4 w-full rounded bg-muted" />
              <div className="h-4 w-11/12 rounded bg-muted" />
              <div className="h-4 w-4/6 rounded bg-muted" />
            </div>
          ) : article.content && article.content.trim().length > 0 ? (
            <div
              className={`animate-fade-in-up animation-delay-200 article-content min-w-0 max-w-full overflow-hidden ${hideArticleImage ? "hide-images " : ""}${readerFontSizeClass[readerFontSize] ?? readerFontSizeClass.medium}`}
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
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-(--z-toast) bg-background/95 backdrop-blur-bar pl-[max(1rem,var(--safe-l))] pr-[max(1rem,var(--safe-r))] pb-[max(0.75rem,var(--safe-b))] wide:hidden">
        {/* overflow-hidden: last-resort net for this row too (see the
            min-w-0 additions below) — if six flex-1 buttons ever don't fit
            (the unread-toggle button is wider than the rest, being the one
            icon button without size="icon"'s fixed square), they clip to
            this pill's rounded shape instead of spilling past it onto the
            screen edge. */}
        <div className="flex h-16 items-center overflow-hidden rounded-sheet border border-border/70 bg-background/90 px-1 shadow-overlay backdrop-blur-bar supports-[backdrop-filter]:bg-background/75">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 min-w-0 flex-1 rounded-2xl text-muted-foreground active:scale-95"
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
              "h-11 min-w-0 flex-1 rounded-2xl active:scale-95",
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
              "h-11 min-w-0 flex-1 rounded-2xl active:scale-95 transition-all duration-(--dur-base)",
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
              "h-11 min-w-0 flex-1 rounded-2xl active:scale-95",
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
                className="h-11 min-w-0 flex-1 rounded-2xl text-muted-foreground active:scale-95"
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
              {canExport && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="rounded-2xl py-3">
                    <Send className="me-3 h-4 w-4" />
                    {t("sendTo")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-48 rounded-2xl p-2">
                    {exportSettings?.obsidianConfigured && (
                      <DropdownMenuItem className="rounded-xl" onClick={sendToObsidian} disabled={buildObsidianLink.isPending}>
                        {t("sendToObsidian")}
                      </DropdownMenuItem>
                    )}
                    {exportSettings?.wallabagConfigured && (
                      <DropdownMenuItem className="rounded-xl" onClick={sendToWallabagHandler} disabled={exportToWallabag.isPending}>
                        {t("sendToWallabag")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              {/* No content-length gate here: it used to hide this for any
                  article whose raw HTML topped 900 chars, which markup-heavy
                  teasers (follow-us links, promo boxes) exceed while showing
                  barely a paragraph of text. Fetching is a deliberate manual
                  action and the server already rejects fetches that don't
                  improve the article, so always offer it when a link exists. */}
              {article.link && (
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
            className="h-11 min-w-0 flex-1 rounded-2xl text-muted-foreground active:scale-95"
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
