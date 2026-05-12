"use client";

import { useEffect, useRef, type TouchEvent } from "react";
import Image from "next/image";
import { Article } from "@/lib/rss-data";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

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
}

const readerWidthClass: Record<string, string> = {
  normal: "max-w-3xl",
  wide: "max-w-5xl",
  full: "max-w-none",
};

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
}: ArticleReaderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!article?.id) return;

    const animationFrame = window.requestAnimationFrame(() => {
      const viewport = rootRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      );
      viewport?.scrollTo({ top: 0, left: 0 });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [article?.id]);

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
          <h2 className="text-2xl font-bold text-foreground mb-3 text-balance">
            Select an article to read
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed">
            Choose an article from the list to start reading. Your reading
            progress will be saved automatically.
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
    toast.success("Link copied");
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

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (!touchStart.current) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - touchStart.current.x;
    const deltaY = touch.clientY - touchStart.current.y;
    touchStart.current = null;

    if (Math.abs(deltaX) < 72 || Math.abs(deltaY) > 64) return;
    if (deltaX < 0 && hasNextArticle) onNextArticle?.();
    if (deltaX > 0) {
      if (hasPreviousArticle) onPreviousArticle?.();
      else onBack?.();
    }
  };

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
      <header className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-border/60 bg-background/80 backdrop-blur-2xl sticky top-0 z-10">
        <div className="flex items-center gap-4">
          {showBackButton && (
            <Button
              variant="ghost"
              size="icon"
              className="w-10 h-10 rounded-xl hover:bg-muted transition-all duration-200 hover:scale-105 active:scale-95"
              onClick={onBack}
            >
              <ChevronLeft className="w-5 h-5" />
            </Button>
          )}
          <button
            type="button"
            onClick={() => onOpenFeed?.(article.feedId)}
            className="flex min-w-0 items-center gap-3 rounded-2xl px-2 py-1.5 text-left transition-colors hover:bg-muted/70 active:scale-[0.99]"
            aria-label={`Show all articles from ${article.feedName}`}
          >
            <span className="text-xl">{article.feedIcon}</span>
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
            title={article.isStarred ? "Remove star (s)" : "Star (s)"}
          >
            <Star
              className={cn(
                "w-5 h-5 transition-all duration-300",
                article.isStarred
                  ? "text-amber-500 fill-amber-500 scale-110"
                  : "text-muted-foreground hover:text-amber-400",
              )}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95",
              article.isReadLater && "bg-accent/10",
            )}
            onClick={() => onToggleReadLater?.(article.id)}
            title={article.isReadLater ? "Remove from Read Later (l)" : "Save to Read Later (l)"}
          >
            <Bookmark
              className={cn(
                "w-5 h-5 transition-all duration-300",
                article.isReadLater
                  ? "text-accent fill-accent scale-110"
                  : "text-muted-foreground hover:text-accent",
              )}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
            onClick={() => onToggleRead?.(article.id)}
            title={article.isRead ? "Mark as unread (m)" : "Mark as read (m)"}
          >
            {article.isRead ? (
              <Circle className="w-5 h-5 text-muted-foreground" />
            ) : (
              <CheckCircle2 className="w-5 h-5 text-muted-foreground" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
            onClick={shareArticle}
            title="Share"
          >
            <Share2 className="w-5 h-5 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
            onClick={openOriginal}
            disabled={!article.link}
            title="Open original (o)"
          >
            <ExternalLink className="w-5 h-5 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
            onClick={copyLink}
            disabled={!article.link}
            title="Copy link"
          >
            <Copy className="w-5 h-5 text-muted-foreground" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
                title="Labels"
              >
                <Tag className="w-5 h-5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-56 rounded-2xl border-border/70 bg-popover/95 p-2 shadow-2xl backdrop-blur-xl"
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Labels
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {labels.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">
                  Create labels in Manage Feeds.
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
      <ScrollArea className="flex-1 overflow-hidden min-h-0">
        <article className={cn("reader-page mx-auto px-5 pt-8 pb-28 sm:px-8 sm:py-12", readerWidthClass[readerWidth] ?? "max-w-3xl")}>
          {/* Article Header */}
          <header className="mb-10 animate-fade-in-up">
            <h1 className="text-2xl sm:text-4xl lg:text-[2.85rem] font-semibold text-foreground leading-[1.08] sm:leading-[1.04] mb-5 text-balance tracking-[-0.035em]">
              {article.title}
            </h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {article.author}
              </span>
              <span className="text-muted-foreground/40">·</span>
              <span>{new Date(article.publishedAt).toLocaleDateString()}</span>
              <span className="text-muted-foreground/40">·</span>
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

          {/* Hero Image */}
          {article.imageUrl && (
            <figure className="mb-12 -mx-6 sm:mx-0 animate-scale-in">
              <div className="aspect-[16/9] sm:rounded-2xl overflow-hidden bg-muted shadow-2xl shadow-black/10 relative">
                <Image
                  src={article.imageUrl || "/placeholder.svg"}
                  alt=""
                  fill
                  sizes="(max-width: 640px) 100vw, 800px"
                  className="object-cover transition-transform duration-700 hover:scale-105"
                />
              </div>
            </figure>
          )}

          {/* Article Body */}
          <div
            className="animate-fade-in-up animation-delay-200 article-content"
            dangerouslySetInnerHTML={{ __html: article.content }}
          />

          {article.link && (!article.content || article.content.length < 900) && (
            <div className="mt-10 rounded-3xl border border-border/70 bg-card/70 p-5 shadow-sm">
              <p className="text-sm text-muted-foreground mb-4">
                This feed appears to provide only a short excerpt. FeedFerret can try to fetch a cleaner full-text version.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => onFetchFullText?.(article.id)}
                  disabled={isFetchingFullText}
                  className="rounded-xl"
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  {isFetchingFullText ? "Fetching..." : "Fetch full text"}
                </Button>
                <Button onClick={openOriginal} variant="outline" className="rounded-xl">
                  <ExternalLink className="w-4 h-4 mr-2" />
                  Open original
                </Button>
              </div>
            </div>
          )}

          {/* Article Footer */}
          <footer className="mt-16 pt-8 border-t border-border animate-fade-in-up animation-delay-300">
            <button
              type="button"
              onClick={() => onOpenFeed?.(article.feedId)}
              className="flex w-full items-center gap-4 rounded-3xl p-2 text-left transition-colors hover:bg-muted/50 active:scale-[0.99]"
            >
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center text-2xl shadow-lg">
                {article.feedIcon}
              </div>
              <div>
                <p className="text-lg font-semibold text-foreground">
                  {article.feedName}
                </p>
                <p className="text-sm text-muted-foreground">
                  View all articles from this feed
                </p>
              </div>
            </button>
          </footer>
        </article>
      </ScrollArea>

      <nav className="fixed inset-x-0 bottom-0 z-[60] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden">
        <div className="flex h-16 items-center gap-1 rounded-[2rem] border border-border/70 bg-background/90 px-2 shadow-2xl shadow-black/20 backdrop-blur-2xl supports-[backdrop-filter]:bg-background/75">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 min-w-10 rounded-2xl text-muted-foreground active:scale-95"
            onClick={hasPreviousArticle ? onPreviousArticle : onBack}
            aria-label={hasPreviousArticle ? "Previous article" : "Back to list"}
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-11 min-w-10 rounded-2xl active:scale-95",
              article.isStarred ? "bg-amber-500/10 text-amber-500" : "text-muted-foreground",
            )}
            onClick={() => onToggleStar(article.id)}
            aria-label={article.isStarred ? "Remove star" : "Star article"}
          >
            <Star className={cn("h-5 w-5", article.isStarred && "fill-amber-500")} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={cn(
              "h-11 min-w-10 rounded-2xl active:scale-95",
              article.isRead ? "bg-muted/70 text-foreground" : "bg-accent text-accent-foreground shadow-lg shadow-accent/20",
            )}
            onClick={() => onToggleRead?.(article.id)}
            aria-pressed={article.isRead}
            aria-label={article.isRead ? "Mark as unread" : "Mark as read"}
          >
            {article.isRead ? <Circle className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-11 min-w-10 rounded-2xl active:scale-95",
              article.isReadLater ? "bg-accent/10 text-accent" : "text-muted-foreground",
            )}
            onClick={() => onToggleReadLater?.(article.id)}
            aria-label={article.isReadLater ? "Remove from Read Later" : "Save to Read Later"}
          >
            <Bookmark className={cn("h-5 w-5", article.isReadLater && "fill-accent")} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 min-w-10 rounded-2xl text-muted-foreground active:scale-95"
            onClick={onNextArticle}
            disabled={!hasNextArticle}
            aria-label="Next article"
          >
            <ChevronRight className="h-5 w-5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 min-w-10 rounded-2xl text-muted-foreground active:scale-95"
                aria-label="More reader actions"
              >
                <MoreHorizontal className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={12}
              className="mb-2 w-64 rounded-3xl border-border/70 bg-popover/95 p-2 shadow-2xl backdrop-blur-xl"
            >
              <DropdownMenuItem className="rounded-2xl py-3" onClick={scrollReaderToTop}>
                <ArrowUp className="mr-3 h-4 w-4" />
                Scroll to top
              </DropdownMenuItem>
              <DropdownMenuItem className="rounded-2xl py-3" onClick={shareArticle}>
                <Share2 className="mr-3 h-4 w-4" />
                Share
              </DropdownMenuItem>
              <DropdownMenuItem className="rounded-2xl py-3" onClick={openOriginal} disabled={!article.link}>
                <ExternalLink className="mr-3 h-4 w-4" />
                Open original
              </DropdownMenuItem>
              <DropdownMenuItem className="rounded-2xl py-3" onClick={copyLink} disabled={!article.link}>
                <Copy className="mr-3 h-4 w-4" />
                Copy link
              </DropdownMenuItem>
              {article.link && (!article.content || article.content.length < 900) && (
                <DropdownMenuItem
                  className="rounded-2xl py-3"
                  onClick={() => onFetchFullText?.(article.id)}
                  disabled={isFetchingFullText}
                >
                  <Sparkles className="mr-3 h-4 w-4" />
                  {isFetchingFullText ? "Fetching…" : "Fetch full text"}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator className="my-2" />
              <DropdownMenuLabel className="text-xs text-muted-foreground">Labels</DropdownMenuLabel>
              {labels.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">Create labels in Manage Feeds.</div>
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
        </div>
      </nav>
    </div>
  );
}
