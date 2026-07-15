"use client";

import { useTranslations } from "next-intl";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { Article } from "@/lib/rss-data";
import { Star, Circle, Clock, CheckCircle2, CircleDot, Bookmark, Layers, RefreshCw, ShieldOff } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty";
import { useState, useRef, useEffect } from "react";

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}.${month} - ${hours}:${minutes}`;
}

function FeedFavicon({ icon, name, size = 16, articleLink }: { icon?: string; name?: string; size?: number; articleLink?: string }) {
  const [failed, setFailed] = useState(false);
  const isUrl = icon ? (icon.startsWith("http") || icon.startsWith("/")) : false;
  let src: string | null = null;
  if (isUrl && icon) {
    src = icon;
  } else if (articleLink) {
    try {
      const domain = new URL(articleLink).hostname;
      src = `https://www.google.com/s2/favicons?domain=${domain}&sz=${Math.max(32, size * 2)}`;
    } catch {}
  }
  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name ?? ""}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className="rounded-sm object-contain shrink-0"
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.55), lineHeight: `${size}px` }}
      className="shrink-0 inline-flex items-center justify-center rounded-sm bg-muted text-muted-foreground font-semibold uppercase"
    >
      {(name ?? "?").trim().charAt(0)}
    </span>
  );
}

function ArticleSkeleton({ viewMode = "list" }: { viewMode?: "list" | "grid" | "magazine" | "minimal" }) {
  if (viewMode === "magazine") {
    return (
      <div className="rounded-3xl border border-border/50 bg-card overflow-hidden animate-pulse">
        <div className="h-36 bg-muted" />
        <div className="p-3 space-y-2">
          <div className="h-3 bg-muted rounded w-1/3" />
          <div className="h-4 bg-muted rounded w-full" />
          <div className="h-4 bg-muted rounded w-3/4" />
        </div>
      </div>
    );
  }
  if (viewMode === "minimal") {
    return (
      <div className="rounded-2xl flex items-center gap-2 px-1 py-1.5 animate-pulse">
        <div className="size-3.5 rounded-full bg-muted shrink-0" />
        <div className="h-3.5 bg-muted rounded flex-1" />
        <div className="h-3 bg-muted rounded w-12 shrink-0" />
      </div>
    );
  }
  return (
    <div className="rounded-2xl sm:rounded-3xl border border-border/50 bg-card p-3 space-y-2.5 animate-pulse">
      <div className="flex items-center gap-2">
        <div className="size-4 rounded-sm bg-muted shrink-0" />
        <div className="h-3 bg-muted rounded w-24" />
        <div className="h-3 bg-muted rounded w-16 ml-auto" />
      </div>
      <div className="space-y-1.5">
        <div className="h-4 bg-muted rounded w-full" />
        <div className="h-4 bg-muted rounded w-5/6" />
      </div>
      <div className="h-3 bg-muted rounded w-3/4" />
    </div>
  );
}

interface ArticleListProps {
  articles: Article[];
  selectedArticle: Article | null;
  onSelectArticle: (article: Article) => void;
  onToggleRead?: (articleId: string) => void;
  onToggleStar?: (articleId: string) => void;
  onToggleReadLater?: (articleId: string) => void;
  onReleaseSpoiler?: (articleId: string) => void;
  viewMode?: "list" | "grid" | "magazine" | "minimal";
  isLoading?: boolean;
  pageSize?: number;
  markReadOnScroll?: boolean;
  onMarkRead?: (articleId: string) => void;
  enablePullToRefresh?: boolean;
  isRefreshing?: boolean;
  onPullToRefresh?: () => void;
  filterKey?: string;
  transitionStyle?: "fade" | "flip" | "filter";
  onOverscrollPastEnd?: () => void;
  onOverscrollPastTop?: () => void;
  onSwipeNextFeed?: () => void;
  onSwipePreviousFeed?: () => void;
  scrollBackToId?: string | null;
}

export function ArticleList({
  articles,
  selectedArticle,
  onSelectArticle,
  onToggleRead,
  onToggleStar,
  onToggleReadLater,
  onReleaseSpoiler,
  viewMode = "list",
  isLoading = false,
  pageSize,
  markReadOnScroll = false,
  onMarkRead,
  enablePullToRefresh = false,
  isRefreshing = false,
  onPullToRefresh,
  filterKey,
  transitionStyle = "fade",
  onOverscrollPastEnd,
  onOverscrollPastTop,
  onSwipeNextFeed,
  onSwipePreviousFeed,
  scrollBackToId,
}: ArticleListProps) {
  const t = useTranslations("articleList");
  const transitionClass =
    transitionStyle === "flip"
      ? "animate-feed-flip"
      : transitionStyle === "filter"
        ? "animate-filter-swap"
        : "animate-fade-in";

  // Background horizontal swipe handlers — only fire when the touch started
  // outside an <article> element so per-article swipes (star/read) keep working.
  const bgSwipeRef = useRef<{ x: number; y: number; onArticle: boolean } | null>(null);
  const handleBgSwipeStart = (e: React.TouchEvent) => {
    if (!onSwipeNextFeed && !onSwipePreviousFeed) return;
    const touch = e.touches[0];
    const onArticle = !!(touch.target as HTMLElement | null)?.closest?.("article");
    bgSwipeRef.current = { x: touch.clientX, y: touch.clientY, onArticle };
  };
  const handleBgSwipeEnd = (e: React.TouchEvent) => {
    if (!bgSwipeRef.current) return;
    const start = bgSwipeRef.current;
    bgSwipeRef.current = null;
    if (start.onArticle) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    
    const isRtl = typeof document !== "undefined" && document.documentElement.getAttribute("dir") === "rtl";
    const goNext = isRtl ? dx > 0 : dx < 0;
    if (goNext) onSwipeNextFeed?.();
    else onSwipePreviousFeed?.();
  };
  const [visibleCount, setVisibleCount] = useState(pageSize ?? 30);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const [pullTriggered, setPullTriggered] = useState(false);
  const pullDistanceRef = useRef(0);
  const isPullingRef = useRef(false);

  const firstArticleId = articles[0]?.id ?? null;
  useEffect(() => {
    setVisibleCount(pageSize ?? 30);
  }, [firstArticleId, pageSize]);

  // Restore scroll position to the previously selected article when the reader closes
  useEffect(() => {
    if (!scrollBackToId || !scrollRoot) return;
    const el = contentRef.current?.querySelector<HTMLElement>(`[data-article-id="${scrollBackToId}"]`);
    if (!el) return;
    const elTop = el.getBoundingClientRect().top;
    const rootTop = scrollRoot.getBoundingClientRect().top;
    const offset = scrollRoot.scrollTop + elTop - rootTop - 80;
    scrollRoot.scrollTo({ top: Math.max(0, offset), behavior: "instant" });
  }, [scrollBackToId, scrollRoot]);

  useEffect(() => {
    const nextRoot = contentRef.current?.closest(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLElement | null;
    setScrollRoot(nextRoot);
  }, [articles.length, viewMode]);

  useEffect(() => {
    if (!isRefreshing) setPullTriggered(false);
  }, [isRefreshing]);

  useEffect(() => {
    if (!enablePullToRefresh || !scrollRoot) return;

    let startY = 0;
    let gestureActive = false;

    const resetPull = () => {
      gestureActive = false;
      isPullingRef.current = false;
      pullDistanceRef.current = 0;
      setIsPulling(false);
      setPullDistance(0);
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || isRefreshing || scrollRoot.scrollTop > 0) return;
      startY = event.touches[0].clientY;
      gestureActive = true;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!gestureActive || event.touches.length !== 1) return;
      if (scrollRoot.scrollTop > 0) {
        resetPull();
        return;
      }

      const deltaY = event.touches[0].clientY - startY;
      if (deltaY <= 0) {
        if (pullDistanceRef.current > 0) {
          pullDistanceRef.current = 0;
          isPullingRef.current = false;
          setPullDistance(0);
          setIsPulling(false);
        }
        return;
      }

      const nextDistance = Math.min(96, deltaY * 0.45);
      pullDistanceRef.current = nextDistance;
      isPullingRef.current = true;
      setIsPulling(true);
      setPullDistance(nextDistance);
      event.preventDefault();
    };

    const handleTouchEnd = () => {
      if (!gestureActive && !isPullingRef.current) return;
      const shouldRefresh = pullDistanceRef.current >= 72;
      resetPull();
      if (shouldRefresh && !isRefreshing) {
        setPullTriggered(true);
        onPullToRefresh?.();
      }
    };

    scrollRoot.addEventListener("touchstart", handleTouchStart, { passive: true });
    scrollRoot.addEventListener("touchmove", handleTouchMove, { passive: false });
    scrollRoot.addEventListener("touchend", handleTouchEnd);
    scrollRoot.addEventListener("touchcancel", handleTouchEnd);

    return () => {
      scrollRoot.removeEventListener("touchstart", handleTouchStart);
      scrollRoot.removeEventListener("touchmove", handleTouchMove);
      scrollRoot.removeEventListener("touchend", handleTouchEnd);
      scrollRoot.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [enablePullToRefresh, isRefreshing, onPullToRefresh, scrollRoot]);

  const visibleArticles = articles.slice(0, visibleCount);
  const hasMore = visibleCount < articles.length;
  const showPullIndicator = enablePullToRefresh && (pullDistance > 0 || pullTriggered);
  const pullReady = pullDistance >= 72;

  // Overscroll-past-end / past-top → navigate feeds (#11)
  useEffect(() => {
    if (!scrollRoot || (!onOverscrollPastEnd && !onOverscrollPastTop)) return;

    let accum = 0;
    let lastFire = 0;
    const COOLDOWN = 1200;
    const THRESHOLD = 500;

    const fire = (dir: 1 | -1) => {
      const now = Date.now();
      if (now - lastFire < COOLDOWN) return;
      lastFire = now;
      accum = 0;
      if (dir === 1) onOverscrollPastEnd?.();
      else onOverscrollPastTop?.();
    };

    const handleWheel = (e: WheelEvent) => {
      const { scrollTop, scrollHeight, clientHeight } = scrollRoot;
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

    // Wheel only on the feed list. Touch overscroll removed because vertical
    // swipe at the top collides with pull-to-refresh (#5). Mobile users
    // switch feeds via the sidebar or the header-area swipe gesture.
    scrollRoot.addEventListener("wheel", handleWheel, { passive: true });
    return () => {
      scrollRoot.removeEventListener("wheel", handleWheel);
    };
  }, [scrollRoot, onOverscrollPastEnd, onOverscrollPastTop]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount(prev => Math.min(prev + (pageSize ?? 30), articles.length));
        }
      },
      { root: scrollRoot, threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, articles.length, pageSize, scrollRoot]);

  if (isLoading && articles.length === 0) {
    const skeletonCount = viewMode === "magazine" ? 4 : viewMode === "minimal" ? 8 : 6;
    return (
      <div
        key={filterKey ?? "loading"}
        className={cn(
          "flex-1 overflow-hidden p-3 pb-28 lg:pb-3 space-y-2.5",
          viewMode === "magazine" && "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-4 space-y-0",
        )}
      >
        {Array.from({ length: skeletonCount }).map((_, i) => (
          <ArticleSkeleton key={i} viewMode={viewMode} />
        ))}
      </div>
    );
  }

  return (
    <ScrollArea
      key={filterKey ?? "default"}
      onTouchStart={handleBgSwipeStart}
      onTouchEnd={handleBgSwipeEnd}
      className={cn("flex-1 overflow-hidden min-h-0", transitionClass)}
    >
      {showPullIndicator && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3">
          <div className="flex items-center gap-2 rounded-full border border-border/70 bg-background/95 px-4 py-2 text-xs font-medium text-muted-foreground shadow-lg backdrop-blur-xl">
            <RefreshCw className={cn("h-3.5 w-3.5", (isRefreshing || pullTriggered) && "animate-spin", pullReady && !isRefreshing && "text-foreground")} />
            <span>
              {isRefreshing || pullTriggered
                ? t("refreshingFeeds")
                : pullReady
                  ? t("releaseToRefresh")
                  : t("pullToRefresh")}
            </span>
          </div>
        </div>
      )}
      {articles.length === 0 ? (
        <div
          ref={contentRef}
          className="flex items-center justify-center p-4 py-20"
        >
          <Empty className="border-0">
            <EmptyMedia variant="icon"><Circle className="size-6" /></EmptyMedia>
            <EmptyContent>
              <EmptyTitle>{t("noArticles")}</EmptyTitle>
              <EmptyDescription>{t("noArticlesDescription")}</EmptyDescription>
            </EmptyContent>
          </Empty>
        </div>
      ) : (
        <div
          ref={contentRef}
          style={{
            transform: pullDistance > 0 ? `translateY(${pullDistance}px)` : undefined,
            transition: isPulling ? "none" : "transform 180ms cubic-bezier(0.16, 1, 0.3, 1)",
          }}
          className={cn(
            "p-3 pb-28 lg:pb-3 space-y-2.5",
            viewMode === "magazine" &&
              "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-4 space-y-0",
          )}
        >
          {visibleArticles.map((article, index) => (
            <ArticlePreview
              key={article.id}
              article={article}
              isSelected={selectedArticle?.id === article.id}
              onClick={() => onSelectArticle(article)}
              onToggleRead={onToggleRead}
              onToggleStar={onToggleStar}
              onToggleReadLater={onToggleReadLater}
              onReleaseSpoiler={onReleaseSpoiler}
              index={index}
              viewMode={viewMode}
              markReadOnScroll={markReadOnScroll}
              onMarkRead={onMarkRead}
              scrollRoot={scrollRoot}
            />
          ))}
          {hasMore && (
            <div ref={sentinelRef} className="flex items-center justify-center py-6 text-sm text-muted-foreground">
              <div className="w-5 h-5 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin me-2" />
              {t("loadingMore")}
            </div>
          )}
        </div>
      )}
    </ScrollArea>
  );
}

function ArticlePreview({
  article,
  isSelected,
  onClick,
  onToggleRead,
  onToggleStar,
  onToggleReadLater,
  onReleaseSpoiler,
  index,
  viewMode,
  markReadOnScroll,
  onMarkRead,
  scrollRoot,
}: {
  article: Article;
  isSelected: boolean;
  onClick: () => void;
  onToggleRead?: (articleId: string) => void;
  onToggleStar?: (articleId: string) => void;
  onToggleReadLater?: (articleId: string) => void;
  onReleaseSpoiler?: (articleId: string) => void;
  index: number;
  viewMode: string;
  markReadOnScroll?: boolean;
  onMarkRead?: (articleId: string) => void;
  scrollRoot?: HTMLElement | null;
}) {
  const t = useTranslations("articleList");
  const articleRef = useRef<HTMLDivElement>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [swipeActive, setSwipeActive] = useState(false);

  const SWIPE_THRESHOLD = 80;
  const SWIPE_MAX = 160;

  const handleSwipeStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
    setSwipeActive(false);
  };

  const handleSwipeMove = (e: React.TouchEvent) => {
    if (!swipeStartRef.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - swipeStartRef.current.x;
    const dy = touch.clientY - swipeStartRef.current.y;
    if (!swipeActive) {
      // Lock direction: if vertical dominates, abandon swipe
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
        swipeStartRef.current = null;
        setSwipeOffset(0);
        return;
      }
      if (Math.abs(dx) > 8) setSwipeActive(true);
    }
    const clamped = Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, dx));
    setSwipeOffset(clamped);
  };

  const handleSwipeEnd = (e: React.TouchEvent) => {
    if (!swipeStartRef.current) {
      setSwipeOffset(0);
      setSwipeActive(false);
      return;
    }
    const touch = e.changedTouches[0];
    const dx = touch.clientX - swipeStartRef.current.x;
    const dy = touch.clientY - swipeStartRef.current.y;
    swipeStartRef.current = null;
    setSwipeActive(false);
    setSwipeOffset(0);
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx) * 0.75) return;
    
    const isRtl = typeof document !== "undefined" && document.documentElement.getAttribute("dir") === "rtl";
    if (dx > 0) {
      if (isRtl) onToggleStar?.(article.id);
      else onToggleRead?.(article.id);
    } else {
      if (isRtl) onToggleRead?.(article.id);
      else onToggleStar?.(article.id);
    }
  };

  const swipeReady = Math.abs(swipeOffset) >= SWIPE_THRESHOLD;
  const isRtl = typeof document !== "undefined" && document.documentElement.getAttribute("dir") === "rtl";
  const swipeRevealDir: "read" | "star" | null =
    swipeOffset > 12
      ? (isRtl ? "star" : "read")
      : swipeOffset < -12
      ? (isRtl ? "read" : "star")
      : null;
  const swipeStyle: React.CSSProperties = {
    transform: swipeOffset !== 0 ? `translateX(${swipeOffset}px)` : undefined,
    transition: swipeActive ? "none" : "transform 220ms cubic-bezier(0.16, 1, 0.3, 1)",
    touchAction: "pan-y",
  };

  const swipeBackdrop = swipeRevealDir ? (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 flex items-center rounded-2xl px-5",
        swipeRevealDir === "read" ? "justify-start bg-emerald-500/15 text-emerald-500" : "justify-end bg-amber-500/15 text-amber-500",
      )}
      style={{ opacity: Math.min(1, Math.abs(swipeOffset) / SWIPE_THRESHOLD) }}
    >
      {swipeRevealDir === "read" ? (
        <CheckCircle2 className={cn("w-6 h-6 transition-transform", swipeReady && "scale-125")} />
      ) : (
        <Star className={cn("w-6 h-6 transition-transform", swipeReady && "scale-125 fill-amber-500")} />
      )}
    </div>
  ) : null;

  useEffect(() => {
    if (!markReadOnScroll || !onMarkRead || article.isRead) return;
    const el = articleRef.current;
    if (!el) return;
    const root =
      scrollRoot ??
      (el.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null);
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const rootTop = entry.rootBounds?.top ?? 0;
          if (!entry.isIntersecting && entry.boundingClientRect.bottom <= rootTop) {
            onMarkRead(article.id);
          }
        });
      },
      { root, threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [article.id, article.isRead, markReadOnScroll, onMarkRead, scrollRoot]);
  if (viewMode === "minimal") {
    return (
      <div className="relative cv-auto-minimal" data-article-id={article.id}>
        {swipeBackdrop}
      <div
        ref={articleRef}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
        onTouchStart={handleSwipeStart}
        onTouchMove={handleSwipeMove}
        onTouchEnd={handleSwipeEnd}
        style={swipeStyle}
        tabIndex={0}
        role="button"
        aria-label={`${article.isRead ? "" : "Unread: "}${article.title} — ${article.feedName}`}
        aria-pressed={isSelected}
        className={cn(
          "px-3 py-2.5 cursor-pointer rounded-2xl transition-[opacity,background-color,border-color,box-shadow] duration-200 flex min-w-0 max-w-full items-center gap-2.5 overflow-hidden relative focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "border-s-4",
          isSelected
            ? "bg-accent/10 ring-1 ring-accent/20"
            : "hover:bg-card/80",
          !article.isRead ? "border-brand" : "border-transparent",
        )}
      >
        <FeedFavicon icon={article.feedIcon} name={article.feedName} articleLink={article.link} size={14} />
        {!article.isRead && <CircleDot className="w-3 h-3 text-brand shrink-0" />}
        <h3 className={cn("flex-1 text-sm truncate", !article.isRead ? "font-semibold" : "font-medium text-foreground/75")}>{article.title}</h3>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatDate(article.publishedAt)}
        </span>
        {/* Action buttons */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleStar?.(article.id); }}
          className={cn("rounded-md p-1 transition-colors shrink-0", article.isStarred ? "text-amber-500" : "text-muted-foreground hover:text-amber-500")}
          aria-label={article.isStarred ? t("removeStar") : t("star")}
        >
          <Star className={cn("w-3.5 h-3.5", article.isStarred && "fill-amber-500")} />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleReadLater?.(article.id); }}
          className={cn("rounded-md p-1 transition-colors shrink-0", article.isReadLater ? "text-accent" : "text-muted-foreground hover:text-accent")}
          aria-label={article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")}
        >
          <Bookmark className={cn("w-3.5 h-3.5", article.isReadLater && "fill-accent")} />
        </button>
      </div>
      </div>
    );
  }

  if (viewMode === "magazine") {
    return (
      <div className="relative cv-auto-magazine" data-article-id={article.id}>
        {swipeBackdrop}
      <div
        ref={articleRef}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
        onTouchStart={handleSwipeStart}
        onTouchMove={handleSwipeMove}
        onTouchEnd={handleSwipeEnd}
        style={swipeStyle}
        tabIndex={0}
        role="button"
        aria-label={`${article.isRead ? "" : "Unread: "}${article.title} — ${article.feedName}`}
        aria-pressed={isSelected}
        className={cn(
          "cursor-pointer rounded-3xl overflow-hidden transition-all duration-300 border border-border/55 bg-card/75 shadow-sm hover:shadow-lg hover:-translate-y-0.5 backdrop-blur-xl min-w-0 max-w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isSelected && "ring-2 ring-accent border-accent",
          !article.isRead && "ring-1 ring-brand/20",
        )}
      >
        {article.imageUrl && (
          <div className="aspect-[16/10] bg-muted relative overflow-hidden">
            <Image
              src={article.imageUrl}
              alt=""
              fill
              loading="lazy"
              sizes="(max-width: 640px) 100vw, 400px"
              className="object-cover transition-transform duration-500 hover:scale-105"
            />
            <div className="absolute top-3 start-3 flex items-center gap-1.5 px-2 py-1 bg-background/60 backdrop-blur-md rounded-lg text-foreground text-[10px] font-bold">
              <FeedFavicon icon={article.feedIcon} name={article.feedName} articleLink={article.link} size={12} />
              {article.feedName}
            </div>
          </div>
        )}
        {!article.imageUrl && (
          <div className="px-4 pt-3">
            <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-muted rounded-lg text-[10px] font-bold">
              <FeedFavicon icon={article.feedIcon} name={article.feedName} articleLink={article.link} size={12} />
              {article.feedName}
            </span>
          </div>
        )}
        <div className="p-4 space-y-3">
          <h3 className={cn("text-lg leading-tight line-clamp-2 break-words [overflow-wrap:anywhere]", article.isRead ? "font-medium text-foreground/75" : "font-semibold")}>
            {article.title}
          </h3>
          <p className="text-sm text-muted-foreground line-clamp-3 leading-relaxed break-words [overflow-wrap:anywhere]">
            {article.excerpt}
          </p>
          <div className="flex items-center justify-between pt-2 border-t border-border/50">
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground font-medium">
              <Clock className="w-3 h-3" />
              {formatDate(article.publishedAt)}
            </div>
            {/* Always-visible action buttons — no hover gating (#11) */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggleStar?.(article.id); }}
                className={cn("rounded-md p-1 transition-colors", article.isStarred ? "text-amber-500 hover:bg-amber-500/10" : "text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10")}
                aria-label={article.isStarred ? t("removeStar") : t("star")}
              >
                <Star className={cn("w-3.5 h-3.5", article.isStarred && "fill-amber-500")} />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggleReadLater?.(article.id); }}
                className={cn("rounded-md p-1 transition-colors", article.isReadLater ? "text-accent" : "text-muted-foreground hover:text-accent hover:bg-accent/10")}
                aria-label={article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")}
                title={article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")}
              >
                <Bookmark className={cn("w-3.5 h-3.5", article.isReadLater && "fill-accent")} />
              </button>
              {onReleaseSpoiler && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onReleaseSpoiler(article.id); }}
                  className="rounded-md p-1 transition-colors text-amber-500 hover:text-amber-600 hover:bg-amber-500/10"
                  aria-label={t("releaseSpoiler")}
                  title={t("releaseSpoiler")}
                >
                  <ShieldOff className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      </div>
    );
  }

  // Classic View (Default) — also used for "grid" viewMode, which shares this markup.
  return (
    <div className="relative cv-auto-list" data-article-id={article.id}>
      {swipeBackdrop}
    <div
      ref={articleRef}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      onTouchStart={handleSwipeStart}
      onTouchMove={handleSwipeMove}
      onTouchEnd={handleSwipeEnd}
      style={swipeStyle}
      tabIndex={0}
      role="button"
      aria-label={`${article.isRead ? "" : "Unread: "}${article.title} — ${article.feedName}`}
      aria-pressed={isSelected}
      className={cn(
        "p-3 sm:p-3.5 cursor-pointer rounded-2xl sm:rounded-3xl group border min-w-0 max-w-full overflow-hidden",
        "transition-[opacity,background-color,border-color,box-shadow,transform] duration-200 ease-out",
        "active:scale-[0.995] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isSelected
          ? "bg-accent/10 border-accent/25 shadow-lg shadow-accent/5"
          : "border-transparent hover:border-border/70 hover:bg-card/80 hover:shadow-sm",
        !article.isRead ? "bg-card/90 shadow-sm" : "opacity-80",
      )}
    >
      <div className="flex min-w-0 gap-3 sm:gap-4">
        {article.imageUrl && (
          <div className="w-24 h-24 sm:w-32 sm:h-32 rounded-xl overflow-hidden flex-shrink-0 bg-muted relative group-hover:shadow-lg transition-shadow duration-300">
            <Image
              src={article.imageUrl || "/placeholder.svg"}
              alt=""
              fill
              loading="lazy"
              sizes="(max-width: 640px) 96px, 128px"
              className="object-cover transition-transform duration-500 group-hover:scale-105"
            />
            {!article.isRead && (
              <div className="absolute top-2 start-2 w-2.5 h-2.5 rounded-full bg-brand animate-pulse-gentle" />
            )}
          </div>
        )}

        <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
          <div className="flex items-center gap-1.5 sm:gap-2 mb-2">
            <FeedFavicon icon={article.feedIcon} name={article.feedName} articleLink={article.link} size={16} />
            <span className="text-sm font-medium text-muted-foreground truncate">
              {article.feedName}
            </span>
            {(article.duplicateCount ?? 0) > 0 && (
              <span
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px] font-medium shrink-0"
                title={`${t("alsoIn")} ${article.duplicateCount} ${(article.duplicateCount ?? 0) > 1 ? t("otherFeeds") : t("otherFeed")}`}
              >
                <Layers className="w-2.5 h-2.5" />
                {article.duplicateCount}
              </span>
            )}
            {article.isDuplicate && article.canonicalFeedName && (
              <span
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground/70 text-[10px] font-medium shrink-0"
                title={`${t("firstSeenIn")}: ${article.canonicalFeedName}`}
              >
                <Layers className="w-2.5 h-2.5" />
                dup
              </span>
            )}
            <span className="text-muted-foreground/50">·</span>
            <span className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">
              {formatDate(article.publishedAt)}
            </span>
            <div className="ml-auto flex items-center gap-1">
              {article.isStarred && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleStar?.(article.id); }}
                  className="rounded-lg p-1 hover:bg-amber-500/10 transition-colors"
                  aria-label={t("removeStar")}
                >
                  <Star className="w-4 h-4 text-amber-500 fill-amber-500 transition-transform duration-300 group-hover:scale-110" />
                </button>
              )}
              {article.isReadLater && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleReadLater?.(article.id); }}
                  className="rounded-lg p-1 hover:bg-accent/10 transition-colors"
                  aria-label={t("removeFromReadLater")}
                >
                  <Bookmark className="w-4 h-4 text-accent fill-accent" />
                </button>
              )}
            </div>
          </div>

          <h3
            className={cn(
              "text-[0.98rem] sm:text-[1rem] leading-snug mb-2 line-clamp-2 text-balance transition-colors duration-200 tracking-[-0.02em] break-words [overflow-wrap:anywhere]",
              !article.isRead
                ? "font-semibold text-foreground"
                : "font-medium text-foreground/75",
            )}
          >
            {article.title}
          </h3>

          <p className="text-sm text-muted-foreground line-clamp-1 sm:line-clamp-2 leading-relaxed mb-3 break-words [overflow-wrap:anywhere]">
            {article.excerpt}
          </p>

          {!!article.labels?.length && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {article.labels.slice(0, 3).map((item) => (
                <span
                  key={item.label.id}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: item.label.color }}
                  />
                  {item.label.name}
                </span>
              ))}
            </div>
          )}

          <div className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
            <span className="font-medium truncate max-w-[100px]">
              {article.author}
            </span>
            <div className="ml-auto flex items-center gap-1 opacity-100 transition-opacity">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggleRead?.(article.id); }}
                className="rounded-lg p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground"
                aria-label={article.isRead ? t("markAsUnread") : t("markAsRead")}
                title={article.isRead ? t("markAsUnread") : t("markAsRead")}
              >
                {article.isRead ? <Circle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
              </button>
              {!article.isStarred && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleStar?.(article.id); }}
                  className="rounded-lg p-1.5 hover:bg-amber-500/10 text-muted-foreground hover:text-amber-500"
                  aria-label={t("star")}
                  title={t("star")}
                >
                  <Star className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggleReadLater?.(article.id); }}
                className={cn("rounded-lg p-1.5 transition-colors", article.isReadLater ? "text-accent bg-accent/10" : "text-muted-foreground hover:text-accent hover:bg-accent/10")}
                aria-label={article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")}
                title={article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")}
              >
                <Bookmark className={cn("w-4 h-4", article.isReadLater && "fill-accent")} />
              </button>
              {onReleaseSpoiler && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onReleaseSpoiler(article.id); }}
                  className="rounded-lg p-1.5 transition-colors text-amber-500 hover:text-amber-600 hover:bg-amber-500/10"
                  aria-label={t("releaseSpoiler")}
                  title={t("releaseSpoiler")}
                >
                  <ShieldOff className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}
