"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { EndOfListCard } from "@/components/end-of-list-card";
import { BriefingCard } from "@/components/briefing/briefing-card";
import { SearchEmpty, SearchHome } from "@/components/search/search-home";
import { useShellActions, useShellData, useSourcesCollapsed, type ShellData } from "@/components/shell/shell-context";
import { scrollTabToTop, sourcesAreRail, tabLabelIdOf } from "@/components/shell/tabs";
import { toLegacyArticle, type LegacyArticle } from "@/features/articles/legacy-adapter";
import { useArticleActions, useIsMarkingViewRead } from "@/features/articles/mutations";
import { prefetchArticle } from "@/features/articles/prefetch";
import { useArticleList, useNewItemsProbe, type ArticleListResult, type NewItemsProbe } from "@/features/articles/queries";
import { probeSince } from "@/features/articles/new-items";
import { showsBriefing } from "@/features/briefing/api";
import { useBriefing } from "@/features/briefing/queries";
import { showApplies, type ListKey } from "@/features/articles/scope";
import { useCounts, useScopeUnread } from "@/features/bootstrap/queries";
import { formatLoc, listKeyOfLoc, type Loc, type TabId } from "@/features/reader/nav/location";
import { useLayoutClass } from "@/features/reader/layout/layout-class";
import { canMarkAll, markViewScopeOf } from "@/features/reader/nav/sidebar-keys";
import { nav, useNav } from "@/features/reader/nav/store";
import { useReleaseArticleSpoiler } from "@/hooks/use-rss-data";
import { ArticleListView } from "./article-list-view";
import { ListTopBar } from "./list-top-bar";
import { scopeTitle } from "./scope-title";
import { SpoilerGate } from "./spoiler-gate";

/**
 * One list pane per tab (Neu · Gemerkt · Feeds · Suche). Mounts on first
 * activation and then stays mounted (CSS hides it, `inert` takes it out of
 * focus order) so its scroll offset survives; an inactive pane renders
 * nothing new — cache writes do not re-render hidden rows.
 */
export const ListPane = memo(function ListPane({ tab }: { tab: TabId }) {
  const tA11y = useTranslations("accessibility");
  const qc = useQueryClient();
  const liveLoc = useNav((s) => (s.loc.tab === tab ? s.loc : null));
  const active = liveLoc !== null;
  // The list binding ignores the open article: opening / stepping articles
  // must not re-render the list (INP of the tap that opens the reader).
  const lastLoc = useRef<Loc | null>(liveLoc ? { ...liveLoc, articleId: null } : null);
  if (liveLoc && (!lastLoc.current || formatLoc(lastLoc.current) !== formatLoc({ ...liveLoc, articleId: null }))) {
    lastLoc.current = { ...liveLoc, articleId: null };
  }
  const [mounted, setMounted] = useState(active);
  if (active && !mounted) setMounted(true);
  // Compact: the reader is a layer above the list — the covered list leaves
  // the focus order and the a11y tree (focus moves into the reader).
  const layout = useLayoutClass();
  // (Inactive panes are inert anyway: only the active one subscribes to the reader.)
  const covered = useNav((s) => s.loc.tab === tab && !!s.loc.articleId) && layout === "compact";
  const inert = !active || covered;
  // Controlled by the tab bar / rail: a tabpanel named by its tab. Without a
  // visible tablist (expanded, full sidebar) a plain labelled region.
  const labelledBy = tabLabelIdOf(tab, layout, useSourcesCollapsed());

  // Prefetch on intent: a row's body starts loading on pointerdown.
  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("button, a, input")) return;
      const id = target.closest("[data-article-id]")?.getAttribute("data-article-id");
      if (id) prefetchArticle(qc, id);
    },
    [qc],
  );

  return (
    <section
      id={`ff-pane-${tab}`}
      data-pane={`list-${tab}`}
      data-active={active ? "true" : "false"}
      inert={inert || undefined}
      aria-hidden={inert || undefined}
      role={labelledBy ? "tabpanel" : "region"}
      aria-labelledby={labelledBy ?? undefined}
      aria-label={labelledBy ? undefined : tA11y("articleList")}
      onPointerDownCapture={onPointerDown}
      className="relative flex flex-col border-e border-border/60 bg-card/70"
    >
      {mounted && lastLoc.current && <ListPaneData tab={tab} loc={lastLoc.current} active={active} />}
    </section>
  );
});

function ListPaneData({ tab, loc, active }: { tab: TabId; loc: Loc; active: boolean }) {
  const data = useShellData();
  const listKey = useMemo(() => listKeyOfLoc(loc, data.sortOrder === "oldest" ? "old" : "new"), [loc, data.sortOrder]);
  const list = useArticleList(listKey, { active });
  // "↑ N neu": rows newer than this snapshot are counted, never written into the bound list.
  const since = useMemo(() => probeSince(list.snapshotAt, list.items), [list.snapshotAt, list.items]);
  const newItems = useNewItemsProbe(listKey, since, { active });
  // K2 card: shown on the Neu list (all, unread) from the first row paint on.
  // Its GET starts here, together with the list query, so a fast answer is
  // part of the first paint (the card then opens by itself).
  const showBriefing = showsBriefing(tab, loc);
  useBriefing("new", showBriefing);
  const counts = useCounts(true);
  const scopeUnread = useScopeUnread(loc.scope, data.feeds, true);
  const isMarkingAllRead = useIsMarkingViewRead();
  // Selection highlight follows in a deferred render, after the reader painted.
  const selectedId = useDeferredValue(useNav((s) => (s.loc.tab === tab ? s.loc.articleId : null)));
  return (
    <ListPaneView
      tab={tab}
      loc={loc}
      active={active}
      listKey={listKey}
      list={list}
      data={data}
      byFeed={counts.byFeed}
      scopeUnread={scopeUnread}
      isMarkingAllRead={isMarkingAllRead}
      selectedId={selectedId}
      showBriefing={showBriefing}
      newCount={newItems.count}
      applyNew={newItems.apply}
    />
  );
}

interface ViewProps {
  tab: TabId;
  loc: Loc;
  active: boolean;
  listKey: ListKey | null;
  list: ArticleListResult;
  data: ShellData;
  byFeed: Record<string, number>;
  scopeUnread: number | undefined;
  isMarkingAllRead: boolean;
  selectedId: string | null;
  showBriefing: boolean;
  newCount: number;
  applyNew: NewItemsProbe["apply"];
}

// Frozen while inactive: no re-render for hidden panes (data and cache writes included).
const ListPaneView = memo(function ListPaneView(p: ViewProps) {
  const t = useTranslations("sidebar");
  const tShell = useTranslations("shell");
  const tSearch = useTranslations("searchResults");
  const tSearchHome = useTranslations("searchHome");
  const shell = useShellActions();
  const { markViewRead } = useArticleActions();
  const releaseArticleSpoiler = useReleaseArticleSpoiler();
  const { loc, data, list, listKey, active } = p;
  const scope = loc.scope;

  const displayArticles = useMemo(() => list.items.map((a) => toLegacyArticle(a, data.legacyContext)), [list.items, data.legacyContext]);
  // Snapshot semantics: in a server-filtered unread list, rows read in this
  // binding stay (dimmed) until the list changes; bulk mark-read removes them.
  const sessionIds = listKey && data.session.key === listKey.id ? data.session.ids : null;
  const filtered = useMemo(() => {
    if (!scope || !showApplies(scope) || loc.show !== "unread") return displayArticles;
    const keep = new Set(sessionIds ?? []);
    return displayArticles.filter((a) => !a.isRead || keep.has(a.id));
  }, [displayArticles, scope, loc.show, sessionIds]);

  useEffect(() => {
    if (active && listKey) shell.bindSession(listKey.id);
  }, [active, listKey, shell]);
  // Keyboard order (j/k/n/p): the list view reports its display order (members
  // folded under a collapsed story card are skipped); until then the flat list.
  const [navOrder, setNavOrder] = useState<{ source: LegacyArticle[]; order: LegacyArticle[] } | null>(null);
  const onNavOrderChange = useCallback((order: LegacyArticle[]) => setNavOrder({ source: filtered, order }), [filtered]);
  const navArticles = navOrder && navOrder.source === filtered ? navOrder.order : filtered;
  useEffect(() => {
    if (active) shell.activeList.set({ key: listKey?.id ?? null, articles: navArticles });
  }, [active, listKey, navArticles, shell]);

  const [spoilerRevealed, setSpoilerRevealed] = useState<string | null>(null);
  const isSpoiler = scope?.kind === "spoiler";
  const loading = list.status === "pending";
  const unreadCount = p.scopeUnread ?? filtered.filter((a) => !a.isRead).length;
  const selectedArticle = p.selectedId ? (filtered.find((a) => a.id === p.selectedId) ?? null) : null;
  const markAll = scope && canMarkAll(scope) ? () => markViewRead(markViewScopeOf(scope)) : undefined;
  const onMarkRead = useCallback(
    (id: string) => {
      const article = displayArticles.find((a) => a.id === id);
      if (article) shell.markAutoRead(article, "scroll");
    },
    [displayArticles, shell],
  );

  // Next feed (sidebar order, wrapping) with unread — only inside a single feed.
  const feedId = scope?.kind === "feed" ? scope.id : null;
  const nextFeed = useMemo(() => {
    if (!feedId) return null;
    const at = data.feeds.findIndex((f: any) => f.id === feedId);
    if (at === -1) return null;
    return [...data.feeds.slice(at + 1), ...data.feeds.slice(0, at)].find((f: any) => (p.byFeed[f.id] ?? 0) > 0) ?? null;
  }, [data.feeds, feedId, p.byFeed]);
  const continueToNext = () => {
    if (!nextFeed) return;
    if (data.prefs?.markReadOnAdvance && unreadCount > 0 && feedId) markViewRead({ feedId, category: null });
    void nav.goScope({ kind: "feed", id: nextFeed.id });
  };

  const markRange = listKey ? { listKey: listKey.id, sort: listKey.sort, snapshotAt: list.snapshotAt } : null;
  const listProps = {
    articles: filtered,
    selectedArticle,
    onSelectArticle: shell.selectArticle,
    onToggleRead: shell.toggleRead,
    onToggleStar: shell.toggleStar,
    onToggleReadLater: shell.toggleLater,
    isLoading: loading,
    markReadOnScroll: data.prefs?.markReadOnScroll ?? false,
    onMarkRead,
    scrollMemoryKey: listKey?.id ?? null,
    hasMorePages: list.hasMore,
    isFetchingMore: list.isFetchingMore,
    onLoadMore: list.fetchMore,
    loadedCount: list.items.length,
    clusterReadMode: data.prefs?.clusterReadMode === "article" ? ("article" as const) : ("story" as const),
    legacyContext: data.legacyContext,
    markRange,
  };

  const scrollTop = () => scrollTabToTop(p.tab);
  // Only the active pane buffers (its pill unmounts while hidden).
  const newItems = useMemo(() => (active ? { count: p.newCount, apply: p.applyNew } : null), [active, p.newCount, p.applyNew]);
  const title = scope ? scopeTitle(scope, data, t) : tSearchHome("title");

  if (p.tab === "search") {
    // One element tree for root and results: the field (top bar) keeps its
    // focus and draft when the debounced commit swaps the body.
    const count = filtered.length;
    return (
      <>
        <ListTopBar
          tab={p.tab}
          loc={loc}
          title={scope?.kind === "query" ? scope.q : title}
          unreadCount={0}
          active={active}
          isRefreshing={loading || data.isRefreshing}
          onMarkAllRead={markAll}
          isMarkingAllRead={p.isMarkingAllRead}
          onScrollTop={scrollTop}
          resultSummary={`${tSearch("resultsCount", { count })} · ${tSearch("unreadCount", { count: unreadCount })}`}
        />
        {scope?.kind === "query" ? (
          <ArticleListView
            {...listProps}
            viewMode="list"
            searchQuery={scope.q}
            endOfList={count === 0 && !loading ? <SearchEmpty /> : undefined}
          />
        ) : (
          <SearchHome />
        )}
      </>
    );
  }

  if (!scope) {
    // Feeds root on wide (compact shows the sources pane instead).
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center text-body-sm text-muted-foreground">
        {tShell("chooseFeed")}
        <button
          type="button"
          onClick={() => (sourcesAreRail() ? shell.openSources() : undefined)}
          className="hidden rounded-control border border-divider px-4 py-2.5 font-medium text-foreground medium:inline-flex"
        >
          {tShell("showFeeds")}
        </button>
      </div>
    );
  }

  const spoilerKey = listKey?.id ?? "";
  return (
    <>
      <ListTopBar
        tab={p.tab}
        loc={loc}
        title={title}
        unreadCount={unreadCount}
        active={active}
        isRefreshing={loading || data.isRefreshing}
        onMarkAllRead={markAll}
        isMarkingAllRead={p.isMarkingAllRead}
        onScrollTop={scrollTop}
      />
      {isSpoiler && spoilerRevealed !== spoilerKey ? (
        <SpoilerGate onReveal={() => setSpoilerRevealed(spoilerKey)} />
      ) : (
        <ArticleListView
          {...listProps}
          groupStories={scope.kind !== "later" && scope.kind !== "starred" && scope.kind !== "recent"}
          onNavOrderChange={onNavOrderChange}
          viewMode={data.viewMode}
          onReleaseSpoiler={isSpoiler ? (id) => releaseArticleSpoiler.mutate(id) : undefined}
          enablePullToRefresh
          isRefreshing={loading || data.isRefreshing}
          isSyncing={data.isRefreshing}
          newItems={newItems}
          onPullToRefresh={shell.refresh}
          endOfList={
            <EndOfListCard
              caughtUp={unreadCount === 0}
              onMarkAllRead={markAll}
              isMarkingAllRead={p.isMarkingAllRead}
              nextFeedName={nextFeed?.name ?? null}
              onContinue={continueToNext}
              continueMarksRead={data.prefs?.markReadOnAdvance ?? false}
            />
          }
          hasFeeds={data.feeds.length > 0}
          header={p.showBriefing ? <BriefingCard scopeKey="new" active={active} /> : undefined}
        />
      )}
    </>
  );
}, (prev, next) => (!prev.active && !next.active) || shallowEqual(prev, next));

const LIST_FIELDS = ["items", "status", "isPlaceholder", "hasMore", "isFetchingMore"] as const;

function shallowEqual(a: ViewProps, b: ViewProps): boolean {
  return (Object.keys(a) as (keyof ViewProps)[]).every((key) =>
    key === "list" ? LIST_FIELDS.every((f) => Object.is(a.list[f], b.list[f])) : Object.is(a[key], b[key]),
  );
}

