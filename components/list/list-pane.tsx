"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { ArticleList } from "@/components/article-list";
import { EndOfListCard } from "@/components/end-of-list-card";
import { RssHeader } from "@/components/rss-header";
import { SearchResultsView } from "@/components/search-results-view";
import { OfflineChip } from "@/components/shell/offline-chip";
import { useShellActions, useShellData, type ShellData } from "@/components/shell/shell-context";
import { clearSearch, searchDraft, useSearchDraft } from "@/components/shell/search-draft";
import { toLegacyArticle } from "@/features/articles/legacy-adapter";
import { useArticleActions, useIsMarkingViewRead } from "@/features/articles/mutations";
import { prefetchArticle } from "@/features/articles/prefetch";
import { useArticleList, type ArticleListResult } from "@/features/articles/queries";
import { showApplies, type ListKey } from "@/features/articles/scope";
import { useCounts, useOnline, useScopeUnread } from "@/features/bootstrap/queries";
import { formatLoc, listKeyOfLoc, type Loc, type TabId } from "@/features/reader/nav/location";
import { canMarkAll, markViewScopeOf } from "@/features/reader/nav/sidebar-keys";
import { nav, useNav } from "@/features/reader/nav/store";
import { useReleaseArticleSpoiler } from "@/hooks/use-rss-data";
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
      data-pane={`list-${tab}`}
      data-active={active ? "true" : "false"}
      inert={!active || undefined}
      aria-hidden={!active || undefined}
      role="region"
      aria-label={tA11y("articleList")}
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
  const counts = useCounts(true);
  const scopeUnread = useScopeUnread(loc.scope, data.feeds, true);
  const isMarkingAllRead = useIsMarkingViewRead();
  const online = useOnline();
  const [draft] = useSearchDraft();
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
      online={online}
      draft={draft}
      selectedId={selectedId}
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
  online: boolean;
  draft: string;
  selectedId: string | null;
}

// Frozen while inactive: no re-render for hidden panes (data and cache writes included).
const ListPaneView = memo(function ListPaneView(p: ViewProps) {
  const t = useTranslations("sidebar");
  const tShell = useTranslations("shell");
  const tSearch = useTranslations("searchResults");
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
  useEffect(() => {
    if (active) shell.activeList.set({ key: listKey?.id ?? null, articles: filtered });
  }, [active, listKey, filtered, shell]);

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

  if (!scope) {
    // Feeds root on wide (compact shows the sources pane instead) / Suche root.
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center text-sm text-muted-foreground">
        {p.tab === "search" ? (
          <button type="button" onClick={shell.openSearch} className="rounded-xl border border-border/60 px-4 py-2.5 font-medium">
            {t("searchArticles")}
          </button>
        ) : (
          tShell("chooseFeed")
        )}
        {p.tab === "search" && <span>{tSearch("globalSearchHint")}</span>}
      </div>
    );
  }

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
  };

  if (scope.kind === "query") {
    return (
      <SearchResultsView
        {...listProps}
        searchQuery={scope.q}
        unreadCount={unreadCount}
        onCloseSearch={() => void clearSearch()}
        onEditSearch={shell.openSearch}
        onSaveSearch={() => shell.saveSearch(scope.q)}
      />
    );
  }

  const spoilerKey = listKey?.id ?? "";
  return (
    <>
      <RssHeader
        title={scopeTitle(scope, data, t)}
        articleCount={filtered.length}
        unreadCount={unreadCount}
        viewMode={data.viewMode}
        onViewModeChange={shell.setViewMode}
        onToggleSidebar={shell.openSources}
        onRefresh={shell.refresh}
        isRefreshing={loading || data.isRefreshing}
        unreadOnly={loc.show === "unread"}
        onToggleUnreadOnly={() => void nav.setShow(loc.show === "unread" ? "all" : "unread")}
        searchQuery={p.draft}
        onSearchChange={searchDraft.set}
        onMarkAllRead={markAll}
        isMarkingAllRead={p.isMarkingAllRead}
        onSaveSearch={() => shell.saveSearch(p.draft)}
        onShowShortcuts={() => shell.setShortcutsOpen(true)}
        sortOrder={data.sortOrder}
        onToggleSort={shell.toggleSort}
      />
      {!p.online && (
        <div className="flex justify-center border-b border-border/60 px-4 py-2">
          <OfflineChip />
        </div>
      )}
      {isSpoiler && spoilerRevealed !== spoilerKey ? (
        <SpoilerGate onReveal={() => setSpoilerRevealed(spoilerKey)} />
      ) : (
        <ArticleList
          {...listProps}
          viewMode={data.viewMode}
          onReleaseSpoiler={isSpoiler ? (id) => releaseArticleSpoiler.mutate(id) : undefined}
          enablePullToRefresh
          isRefreshing={loading || data.isRefreshing}
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

