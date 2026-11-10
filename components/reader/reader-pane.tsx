"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, memo, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useShellActions, useShellData } from "@/components/shell/shell-context";
import { toLegacyArticle, withDetail } from "@/features/articles/legacy-adapter";
import { useArticleActions, useIsFetchingFullText } from "@/features/articles/mutations";
import { prefetchArticle } from "@/features/articles/prefetch";
import { useArticle } from "@/features/articles/queries";
import { getLayoutClass } from "@/features/reader/layout/layout-class";
import { getNavState, nav, useNav } from "@/features/reader/nav/store";
import { ReaderEmptyState } from "./reader-empty";

// The reader (its UI, menus, export / AI hooks, KaTeX + highlight.js CSS) is
// its own chunk: off the cold-start path, preloaded once the shell is idle so
// the first tap still paints the reader at once. A deep link (`?a=`) renders
// it on the server and loads the chunk with the page.
const loadReader = () => import("@/components/article-reader");
const ArticleReader = dynamic(() => loadReader().then((m) => m.ArticleReader), {
  loading: () => <div className="flex-1 bg-background" />,
});

/**
 * Reader container: the open article comes from the URL (`a`). On compact it
 * is a fixed layer above the (still mounted) list; on wide the right column.
 * Keeps the last article while the compact close transition runs.
 */
export const ReaderPane = memo(function ReaderPane() {
  const tA11y = useTranslations("accessibility");
  const qc = useQueryClient();
  const articleId = useNav((s) => s.loc.articleId);
  const { labels, prefs, feeds, legacyContext, suppressed } = useShellData();
  const shell = useShellActions();
  const actions = useArticleActions();
  const isFetchingFullText = useIsFetchingFullText();
  const paneRef = useRef<HTMLElement>(null);

  // Last opened id survives the close until the pane's transition has ended.
  const [shownId, setShownId] = useState(articleId);
  if (articleId && articleId !== shownId) setShownId(articleId);
  useEffect(() => {
    if (articleId || !shownId) return;
    const pane = paneRef.current;
    const duration = pane ? parseFloat(getComputedStyle(pane).transitionDuration) || 0 : 0;
    if (!pane || duration === 0) {
      setShownId(null);
      return;
    }
    const done = (e: TransitionEvent) => {
      if (e.target === pane) setShownId(null);
    };
    pane.addEventListener("transitionend", done);
    pane.addEventListener("transitioncancel", done);
    return () => {
      pane.removeEventListener("transitionend", done);
      pane.removeEventListener("transitioncancel", done);
    };
  }, [articleId, shownId]);

  useReaderFocus(paneRef, articleId);
  usePreloadReader();

  const list = useSyncExternalStore(shell.activeList.subscribe, shell.activeList.get, shell.activeList.get);
  const { item, detail, status } = useArticle(shownId);
  const article = useMemo(() => {
    if (!shownId) return null;
    const inList = list.articles.find((a) => a.id === shownId);
    if (inList) return inList;
    return item ? toLegacyArticle(item, legacyContext) : null;
  }, [list.articles, shownId, item, legacyContext]);
  const readerArticle = useMemo(() => (article ? withDetail(article, detail) : null), [article, detail]);
  const index = shownId ? list.articles.findIndex((a) => a.id === shownId) : -1;

  // Unknown / foreign id in a deep link: back to the list instead of an empty reader.
  useEffect(() => {
    if (articleId && status === "error" && !item) void nav.closeArticle();
  }, [articleId, status, item]);

  // Auto mark-read after the configured delay (null → 1 s, 0 → off).
  useEffect(() => {
    if (!articleId || !article || article.id !== articleId || article.isRead || suppressed.includes(article.id)) return;
    const delaySecs = prefs?.markReadAfterDelaySecs ?? null;
    if (delaySecs === 0) return;
    const timer = window.setTimeout(() => shell.markAutoRead(article, "auto"), delaySecs !== null ? delaySecs * 1000 : 1000);
    return () => window.clearTimeout(timer);
  }, [articleId, article, suppressed, prefs?.markReadAfterDelaySecs, shell]);

  // Idle prefetch of the next two bodies in list order.
  useEffect(() => {
    if (!articleId || index < 0) return;
    const next = list.articles.slice(index + 1, index + 3);
    const run = () => next.forEach((a) => prefetchArticle(qc, a.id));
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(run, { timeout: 2000 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(run, 300);
    return () => window.clearTimeout(handle);
  }, [articleId, index, list.articles, qc]);

  const feed = feeds.find((f: any) => f.id === readerArticle?.feedId);
  const step = (dir: 1 | -1) => {
    const target = list.articles[index + dir];
    if (target) void nav.stepArticle(target.id);
  };

  return (
    <section
      ref={paneRef}
      data-pane="reader"
      role="region"
      aria-label={tA11y("articleReader")}
      tabIndex={-1}
      className="flex bg-background outline-none"
    >
      {readerArticle ? (
        <ArticleReader
          article={readerArticle}
          isBodyLoading={!!article && status === "pending"}
          onToggleStar={shell.toggleStar}
          onToggleReadLater={shell.toggleLater}
          onToggleRead={shell.toggleRead}
          onFetchFullText={actions.fetchFullText}
          isFetchingFullText={isFetchingFullText}
          labels={labels}
          onSetLabels={actions.setLabels}
          onBack={() => void nav.up()}
          onOpenFeed={(feedId) => void nav.goScope({ kind: "feed", id: feedId })}
          showBackButton={!!articleId}
          onPreviousArticle={() => step(-1)}
          onNextArticle={() => step(1)}
          hasPreviousArticle={index > 0}
          hasNextArticle={index >= 0 && index < list.articles.length - 1}
          readerWidth={(feed?.readerWidthOverride ?? prefs?.readerWidth ?? "normal") as "normal" | "wide" | "full"}
          readerFontSize={(feed?.readerFontSizeOverride ?? prefs?.readerFontSize ?? "medium") as "small" | "medium" | "large" | "xl"}
          hideArticleImage={feed?.hideArticleImage ?? false}
        />
      ) : (
        <ReaderEmptyState />
      )}
    </section>
  );
});

/** Loads the reader chunk once the browser is idle after boot (no-op when already loaded). */
function usePreloadReader() {
  useEffect(() => {
    const run = () => void loadReader();
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(run, { timeout: 4000 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(run, 1500);
    return () => window.clearTimeout(handle);
  }, []);
}

/**
 * Compact: the reader is a layer over the (then inert) list. Opening moves
 * focus into the reader; closing returns it to the row the article was
 * opened from (or the last one stepped to). Wide keeps focus where it is
 * (both panes are visible and j/k drive the list).
 */
function useReaderFocus(paneRef: RefObject<HTMLElement | null>, articleId: string | null) {
  const previous = useRef<string | null>(articleId);
  useEffect(() => {
    const prev = previous.current;
    previous.current = articleId;
    if (getLayoutClass() !== "compact" || !!prev === !!articleId) return;
    if (articleId) {
      const pane = paneRef.current;
      if (pane && !pane.contains(document.activeElement)) pane.focus({ preventScroll: true });
      return;
    }
    const tab = getNavState().loc.tab;
    const row = document.querySelector<HTMLElement>(`[data-pane="list-${tab}"] [data-article-id="${CSS.escape(prev!)}"]`);
    const target = row?.querySelector<HTMLElement>('[tabindex="0"]') ?? row;
    target?.focus({ preventScroll: true });
  }, [articleId, paneRef]);
}
