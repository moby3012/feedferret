"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bookmark, BookmarkMinus, CheckCheck, CheckCircle2, Circle, Circle as CircleIcon, ExternalLink, Layers, Link2, RefreshCw, Star, StarOff } from "lucide-react";
import { Empty, EmptyContent, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ResponsiveMenu, type OverlayMenuItem } from "@/components/ui/responsive-overlay";
import { findCachedArticle } from "@/features/articles/cache";
import { qk } from "@/features/articles/keys";
import { toLegacyArticle, type LegacyArticle, type LegacyContext } from "@/features/articles/legacy-adapter";
import { useArticleActions } from "@/features/articles/mutations";
import type { ArticlePage } from "@/features/articles/types";
import { isOnline } from "@/features/bootstrap/online";
import { useRestoreGate, useScrollMemory } from "@/features/reader/nav/scroll-memory";
import { createPull, useGesturePrefs, type LongPressPoint } from "@/lib/gestures";
import { extractHighlightTerms } from "@/lib/highlight-search-terms";
import { cn } from "@/lib/utils";
import { ArticleRow, type Density, type RowHandlers, type RowSwipeMap } from "./article-row";
import { ArticleListSkeleton } from "./article-skeleton";
import { ClusterMembers, groupStories, type DisplayRow } from "./story-cluster";

// The list scroller (spec §3 `ArticleListView`): native scroller, paging
// sentinel, read-on-scroll (one shared observer), scroll memory, pull-to-
// refresh, story cluster cards and the row context menu. Rows are memoized
// and get one stable handler bag: a cache write re-renders only the rows
// whose article object changed, and a drag re-renders nothing at all.

export type ViewMode = "list" | "grid" | "magazine" | "minimal";

export interface ArticleListViewProps {
  articles: LegacyArticle[];
  selectedArticle: { id: string } | null;
  onSelectArticle: (article: LegacyArticle) => void;
  onToggleRead?: (articleId: string) => void;
  onToggleStar?: (articleId: string) => void;
  onToggleReadLater?: (articleId: string) => void;
  onReleaseSpoiler?: (articleId: string) => void;
  viewMode?: ViewMode;
  isLoading?: boolean;
  pageSize?: number;
  markReadOnScroll?: boolean;
  onMarkRead?: (articleId: string) => void;
  enablePullToRefresh?: boolean;
  isRefreshing?: boolean;
  onPullToRefresh?: () => void;
  /** Scroll-memory key of the bound list (canonical list URL). */
  scrollMemoryKey?: string | null;
  /** Rendered once after the last row (and as the empty state when nothing is left). */
  endOfList?: ReactNode;
  /**
   * Rendered once above the first row, inside the scroller (scrolls with the
   * list, never sticky) — e.g. the K2 briefing card of the Neu list.
   */
  header?: ReactNode;
  hasFeeds?: boolean;
  /** Highlights the query's free-text terms in titles / excerpts (search). */
  searchQuery?: string;
  hasMorePages?: boolean;
  isFetchingMore?: boolean;
  onLoadMore?: () => void;
  /** Rows fetched so far (before client-side filtering); re-arms the paging sentinel. */
  loadedCount?: number;
  /** One row per story (cluster card). Off for membership views and search. */
  groupStories?: boolean;
  /** `User.clusterReadMode`: "story" marks every source when the story card is marked. */
  clusterReadMode?: "story" | "article";
  /** Feed / label lookup for cluster member rows. */
  legacyContext?: LegacyContext;
}

const EMPTY_CONTEXT: LegacyContext = { feedsById: new Map(), labelsById: new Map(), labelsReady: true };

function densityOf(mode: ViewMode): Density {
  return mode === "minimal" ? "minimal" : mode === "magazine" || mode === "grid" ? "magazine" : "list";
}

interface MenuState {
  id: string;
  point: LongPressPoint;
  returnFocus: HTMLElement;
}

export function ArticleListView(props: ArticleListViewProps) {
  const {
    articles,
    viewMode = "list",
    isLoading = false,
    pageSize = 30,
    markReadOnScroll = false,
    enablePullToRefresh = false,
    isRefreshing = false,
    scrollMemoryKey = null,
    endOfList,
    hasFeeds = true,
    searchQuery,
    hasMorePages = false,
    isFetchingMore = false,
    onLoadMore,
    loadedCount,
  } = props;
  const t = useTranslations("articleList");
  const qc = useQueryClient();
  const articleActions = useArticleActions();
  const density = densityOf(viewMode);
  const highlightTerms = useMemo(() => extractHighlightTerms(searchQuery ?? ""), [searchQuery]);
  const prefs = useGesturePrefs();
  const swipeMap = useMemo<RowSwipeMap>(() => ({ end: prefs.swipeEnd, start: prefs.swipeStart }), [prefs.swipeEnd, prefs.swipeStart]);

  const rows = useMemo<DisplayRow[]>(
    () => (props.groupStories ? groupStories(articles) : articles.map((article) => ({ article, story: null }))),
    [articles, props.groupStories],
  );

  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pullTriggered, setPullTriggered] = useState(false);

  const firstArticleId = articles[0]?.id ?? null;
  useEffect(() => {
    setVisibleCount(pageSize);
  }, [firstArticleId, pageSize]);

  const rowIds = useMemo(() => rows.map((r) => r.article.id), [rows]);
  const restoreReady = useRestoreGate(scrollMemoryKey, rowIds, visibleCount, {
    reveal: (count) => setVisibleCount((prev) => Math.max(prev, count + pageSize)),
    loadMore: onLoadMore,
    hasMorePages,
    isFetching: isFetchingMore || isLoading,
  });
  useScrollMemory(scrollRoot, scrollMemoryKey, restoreReady);

  // ---------------------------------------------------------- live values
  // The handler bag below never changes identity; it reads everything here.
  const live = useRef({ props, rows, qc, articleActions });
  live.current = { props, rows, qc, articleActions };

  /** Members of a story the card stands for: collapsed siblings + loaded cluster members. */
  const storyMembers = useCallback((repId: string): string[] => {
    const { rows: rs, qc: client } = live.current;
    const story = rs.find((r) => r.article.id === repId)?.story;
    if (!story) return [];
    const ids = new Set(story.siblings.map((s) => s.id));
    const cached = client.getQueryData<{ pages: ArticlePage[] }>(qk.cluster(story.clusterId));
    for (const page of cached?.pages ?? []) for (const item of page.items) if (item.id !== repId) ids.add(item.id);
    return [...ids];
  }, []);

  /** Read toggle; on a story card in "story" mode the whole story follows. */
  const toggleRead = useCallback(
    (id: string) => {
      const { props: p, qc: client } = live.current;
      const before = findCachedArticle(client, id);
      p.onToggleRead?.(id);
      if (!before || p.clusterReadMode !== "story") return;
      const next = !before.isRead;
      for (const memberId of storyMembers(id)) {
        if (findCachedArticle(client, memberId)?.isRead === !next) p.onToggleRead?.(memberId);
      }
    },
    [storyMembers],
  );

  // ---------------------------------------------------- read-on-scroll
  const observeUnread = useMemo(() => {
    if (!markReadOnScroll || !scrollRoot) return undefined;
    const ids = new WeakMap<Element, string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const rootTop = entry.rootBounds?.top ?? 0;
          if (!entry.isIntersecting && entry.boundingClientRect.bottom <= rootTop) {
            const id = ids.get(entry.target);
            if (id) live.current.props.onMarkRead?.(id);
          }
        }
      },
      { root: scrollRoot, threshold: 0 },
    );
    const observe = (el: HTMLElement, id: string) => {
      ids.set(el, id);
      observer.observe(el);
      return () => observer.unobserve(el);
    };
    return Object.assign(observe, { disconnect: () => observer.disconnect() });
  }, [markReadOnScroll, scrollRoot]);
  useEffect(() => () => observeUnread?.disconnect(), [observeUnread]);

  const handlers = useMemo<RowHandlers>(
    () => ({
      open: (article) => live.current.props.onSelectArticle(article),
      toggleRead,
      toggleStar: (id) => live.current.props.onToggleStar?.(id),
      toggleLater: (id) => live.current.props.onToggleReadLater?.(id),
      releaseSpoiler: (id) => live.current.props.onReleaseSpoiler?.(id),
      openMenu: (id, point, returnFocus) => setMenu({ id, point, returnFocus }),
      toggleCluster: (clusterId) =>
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(clusterId)) next.delete(clusterId);
          else next.add(clusterId);
          return next;
        }),
      swipeEnabled: isOnline,
      observeUnread,
    }),
    [toggleRead, observeUnread],
  );

  // ---------------------------------------------------- pull-to-refresh
  useEffect(() => {
    if (!isRefreshing) setPullTriggered(false);
  }, [isRefreshing]);
  useEffect(() => {
    if (!enablePullToRefresh || !scrollRoot) return;
    return createPull(scrollRoot, {
      edge: "top",
      enabled: () => !live.current.props.isRefreshing,
      onTrigger: () => {
        setPullTriggered(true);
        live.current.props.onPullToRefresh?.();
      },
    });
  }, [enablePullToRefresh, scrollRoot]);

  // ---------------------------------------------------------- paging
  const visibleRows = rows.slice(0, visibleCount);
  const hasMoreLoaded = visibleCount < rows.length;
  const hasMore = hasMoreLoaded || hasMorePages;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        // Reveal what is already loaded first; at its end, fetch the next server page.
        if (hasMoreLoaded) setVisibleCount((prev) => Math.min(prev + pageSize, rows.length));
        else if (!isFetchingMore) onLoadMore?.();
      },
      // Two viewports ahead (spec §3): rows are appended long before the
      // sentinel is on screen, so it never visibly jumps (CLS) or stalls.
      { root: scrollRoot, rootMargin: "0px 0px 200% 0px", threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, hasMoreLoaded, rows.length, visibleCount, loadedCount, isFetchingMore, onLoadMore, pageSize, scrollRoot]);

  // Client-side filtering can hide every row of the pages loaded so far: keep
  // paging until something shows up or the server reports the end.
  const pagingThroughHidden = articles.length === 0 && hasMorePages;
  useEffect(() => {
    if (pagingThroughHidden && !isFetchingMore && !isLoading) onLoadMore?.();
  }, [pagingThroughHidden, isFetchingMore, isLoading, loadedCount, onLoadMore]);

  // ------------------------------------------------------------ menu
  const menuArticle = menu ? (articles.find((a) => a.id === menu.id) ?? findMember(qc, menu.id, props.legacyContext)) : null;
  const menuItems = useMemo<OverlayMenuItem[]>(() => {
    if (!menu || !menuArticle) return [];
    const a = menuArticle;
    const displayIndex = rows.findIndex((r) => r.article.id === a.id || r.story?.siblings.some((s) => s.id === a.id));
    const story = displayIndex >= 0 ? rows[displayIndex].story : null;
    const upToHere = displayIndex >= 0 ? rows.slice(0, displayIndex + 1).flatMap((r) => [r.article, ...(r.story?.siblings ?? [])]) : [a];
    const unreadUpToHere = upToHere.filter((x) => !x.isRead).map((x) => x.id);
    const items: OverlayMenuItem[] = [
      { id: "read", label: a.isRead ? t("markAsUnread") : t("markAsRead"), icon: a.isRead ? Circle : CheckCircle2, onSelect: () => toggleRead(a.id) },
      { id: "later", label: a.isReadLater ? t("removeFromReadLater") : t("saveToReadLater"), icon: a.isReadLater ? BookmarkMinus : Bookmark, onSelect: () => props.onToggleReadLater?.(a.id) },
      { id: "star", label: a.isStarred ? t("removeStar") : t("star"), icon: a.isStarred ? StarOff : Star, onSelect: () => props.onToggleStar?.(a.id) },
      {
        id: "open",
        label: t("openOriginal"),
        icon: ExternalLink,
        separated: true,
        onSelect: () => {
          if (a.link) window.open(a.link, "_blank", "noopener,noreferrer");
        },
      },
      {
        id: "copy",
        label: t("copyLink"),
        icon: Link2,
        onSelect: () => {
          void navigator.clipboard?.writeText(a.link).then(
            () => toast.success(t("linkCopied")),
            () => {},
          );
        },
      },
    ];
    if (story && story.more > 0) {
      const open = expanded.has(story.clusterId);
      items.push({ id: "sources", label: open ? t("hideSources") : t("showSources"), icon: Layers, onSelect: () => handlers.toggleCluster(story.clusterId) });
    }
    items.push({
      id: "up-to-here",
      label: t("markUpToHere"),
      icon: CheckCheck,
      separated: true,
      disabled: unreadUpToHere.length === 0,
      onSelect: () => articleActions.markIdsRead(unreadUpToHere),
    });
    return items;
    // `props` callbacks are stable shell actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, menuArticle, rows, expanded, t, toggleRead, handlers, articleActions]);

  // ----------------------------------------------------------- render
  const legacyContext = props.legacyContext ?? EMPTY_CONTEXT;
  const selectedId = props.selectedArticle?.id ?? null;

  if ((isLoading || pagingThroughHidden) && articles.length === 0) {
    return <ArticleListSkeleton viewMode={viewMode} />;
  }

  return (
    <div
      ref={setScrollRoot}
      data-testid="list-scroller"
      data-refreshing={pullTriggered && isRefreshing ? "" : undefined}
      // Compact: the floating bottom bar covers the scroller's last ~5rem;
      // scroll-padding keeps focus / keyboard paging from parking a row under it.
      className="ff-list-scroller relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain scroll-pb-[calc(5rem_+_var(--safe-b))] wide:scroll-pb-0"
    >
      {enablePullToRefresh && (
        <div className="ff-pull-indicator" aria-hidden>
          <div className="flex items-center gap-2 rounded-full border border-divider bg-surface-raised px-3 py-1.5 text-footnote text-muted-foreground shadow-(--shadow-bar)">
            <RefreshCw className={cn("ff-pull-ring size-3.5", pullTriggered && isRefreshing && "animate-spin")} />
            <span>{pullTriggered && isRefreshing ? t("refreshingFeeds") : t("pullToRefresh")}</span>
          </div>
        </div>
      )}
      {articles.length === 0 && endOfList ? (
        <div className="ff-list" data-density="list">
          {props.header && <div className="px-3 pt-3">{props.header}</div>}
          <div className="px-3 pt-3">{endOfList}</div>
        </div>
      ) : articles.length === 0 ? (
        <div className="flex items-center justify-center p-4 py-20">
          <Empty className="border-0">
            <EmptyMedia variant="icon">
              <CircleIcon className="size-6" />
            </EmptyMedia>
            <EmptyContent>
              <EmptyTitle>{hasFeeds ? t("noArticles") : t("noFeedsYet")}</EmptyTitle>
              <EmptyDescription>{hasFeeds ? t("noArticlesDescription") : t("noFeedsYetDescription")}</EmptyDescription>
            </EmptyContent>
          </Empty>
        </div>
      ) : (
        <div className="ff-list" data-density={density}>
          {props.header && <div className="ff-span-all px-3 pb-2 pt-2">{props.header}</div>}
          {visibleRows.map(({ article, story }) => {
            const open = !!story && expanded.has(story.clusterId);
            return (
              <Fragment key={article.id}>
                <ArticleRow
                  article={article}
                  density={density}
                  selected={selectedId === article.id}
                  handlers={handlers}
                  swipeMap={swipeMap}
                  cluster={story && story.more > 0 ? { id: story.clusterId, more: story.more, expanded: open } : null}
                  highlightTerms={highlightTerms}
                  canReleaseSpoiler={!!props.onReleaseSpoiler}
                />
                {open && story && <ClusterMembers story={story} density={density} handlers={handlers} swipeMap={swipeMap} legacyContext={legacyContext} selectedId={selectedId} />}
              </Fragment>
            );
          })}
          {hasMore ? (
            <div ref={sentinelRef} className="ff-span-all flex items-center justify-center py-6 text-body-sm text-muted-foreground">
              <div className="me-2 size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
              {t("loadingMore")}
            </div>
          ) : endOfList ? (
            <div className="ff-span-all px-3 pt-3">{endOfList}</div>
          ) : (
            !!searchQuery && <div className="ff-span-all py-6 text-center text-footnote text-muted-foreground/60">{t("endOfResults")}</div>
          )}
        </div>
      )}
      {menu && menuArticle && (
        <ResponsiveMenu
          open
          onOpenChange={(o) => {
            if (!o) setMenu(null);
          }}
          mode={menu.point.pointerType === "touch" || menu.point.pointerType === "pen" ? "sheet" : "menu"}
          title={menuArticle.displayTitle || menuArticle.title}
          description={menuArticle.displayTitle ? t("originalTitle", { title: menuArticle.title }) : undefined}
          anchor={{ x: menu.point.x, y: menu.point.y }}
          items={menuItems}
          returnFocus={() => (menu.returnFocus.isConnected ? menu.returnFocus : null)}
          testId="article-context-menu"
        />
      )}
    </div>
  );
}

/** A cluster member row (expanded card) the flat list does not hold. */
function findMember(qc: ReturnType<typeof useQueryClient>, id: string, ctx: LegacyContext | undefined): LegacyArticle | null {
  for (const [, data] of qc.getQueriesData<{ pages: ArticlePage[] }>({ queryKey: qk.lists })) {
    for (const page of data?.pages ?? []) {
      const hit = page.items.find((item) => item.id === id);
      if (hit) return toLegacyArticle(hit, ctx ?? EMPTY_CONTEXT);
    }
  }
  return null;
}
