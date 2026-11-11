"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, memo, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { useShellActions, useShellData } from "@/components/shell/shell-context";
import { toLegacyArticle, withDetail } from "@/features/articles/legacy-adapter";
import { useArticleActions, useIsFetchingFullText } from "@/features/articles/mutations";
import { prefetchArticle } from "@/features/articles/prefetch";
import { useArticle } from "@/features/articles/queries";
import { useReaderStacked } from "@/features/reader/layout/layout-class";
import { getNavState, nav, useNav } from "@/features/reader/nav/store";
import { ReaderEmptyState } from "./reader-empty";
import { preloadReaderChunks, ReaderLazyWarmup, ReaderView } from "./reader-view";

// The reader chrome + header ship with the shell, so a tap paints the title
// from the list row in the same frame (spec §2.4: ≤100 ms). Only the body
// (KaTeX + highlight.js CSS), the "…" menu and the "Aa" sheet are lazy chunks,
// preloaded once the shell is idle; a deep link (`?a=`) renders the body on
// the server.

/**
 * Reader container: the open article comes from the URL (`a`). On compact it
 * is a fixed layer above the (still mounted) list; on portrait tablets a layer
 * over the list column (rail stays); from 960 px the right column.
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
  const warm = usePreloadReader();

  const list = useSyncExternalStore(shell.activeList.subscribe, shell.activeList.get, shell.activeList.get);
  const { item, detail, status, isRetrying, retry } = useArticle(shownId);
  const article = useMemo(() => {
    if (!shownId) return null;
    const inList = list.articles.find((a) => a.id === shownId);
    if (inList) return inList;
    // The detail is a superset of the row: a deep link (`?a=`) renders from the
    // bootstrap-hydrated detail on the server (no list cache is readable there).
    const known = item ?? (detail?.id === shownId ? detail : undefined);
    return known ? toLegacyArticle(known, legacyContext) : null;
  }, [list.articles, shownId, item, detail, legacyContext]);
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
        <ReaderView
          article={readerArticle}
          index={index}
          nextTitle={index >= 0 ? (list.articles[index + 1]?.title ?? null) : null}
          isBodyLoading={!!article && status === "pending"}
          bodyError={status === "error" ? { retrying: isRetrying, retry } : null}
          onToggleStar={shell.toggleStar}
          onToggleLater={shell.toggleLater}
          onToggleRead={shell.toggleRead}
          onFetchFullText={actions.fetchFullText}
          isFetchingFullText={isFetchingFullText}
          labels={labels}
          onSetLabels={actions.setLabels}
          onBack={() => void nav.up()}
          onOpenFeed={(feedId) => void nav.goScope({ kind: "feed", id: feedId })}
          onPrevious={() => step(-1)}
          onNext={() => step(1)}
          hasPrevious={index > 0}
          hasNext={index >= 0 && index < list.articles.length - 1}
          typographyFallback={{
            readerWidth: feed?.readerWidthOverride ?? prefs?.readerWidth ?? null,
            readerFontSize: feed?.readerFontSizeOverride ?? prefs?.readerFontSize ?? null,
          }}
          hideArticleImage={feed?.hideArticleImage ?? false}
        />
      ) : (
        <ReaderEmptyState />
      )}
      {warm && <ReaderLazyWarmup />}
    </section>
  );
});

/**
 * Loads the reader's lazy chunks once the browser is idle after boot, then
 * reports `true` so they get mounted (warmed) once — later mounts render at once.
 */
function usePreloadReader() {
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    let alive = true;
    const run = () =>
      void preloadReaderChunks().then(
        () => alive && setWarm(true),
        () => {
          /* offline / chunk error: the reader loads them on demand */
        },
      );
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(run, { timeout: 4000 });
      return () => {
        alive = false;
        window.cancelIdleCallback(handle);
      };
    }
    const handle = window.setTimeout(run, 1500);
    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
  }, []);
  return warm;
}

/**
 * Compact / portrait tablet: the reader is a layer over the (then inert) list.
 * Opening moves focus into the reader; closing returns it to the row the
 * article was opened from (or the last one stepped to). Wide keeps focus where
 * it is (both panes are visible and j/k drive the list).
 *
 * The layout can change under an open article (rotation, window resize across
 * 960 px): when the reader starts covering the list, the list turns inert and
 * would drop focus to <body> — focus moves into the reader instead. When it
 * stops covering it, focus that was lost to <body> goes back to the row.
 */
function useReaderFocus(paneRef: RefObject<HTMLElement | null>, articleId: string | null) {
  const stacked = useReaderStacked();
  const previous = useRef<{ articleId: string | null; stacked: boolean | null }>({ articleId, stacked });
  useEffect(() => {
    const prev = previous.current;
    previous.current = { articleId, stacked };
    if (stacked === null) return; // not mounted yet: layout unknown
    const focusRow = (id: string | null) => {
      if (!id) return;
      const tab = getNavState().loc.tab;
      const row = document.querySelector<HTMLElement>(`[data-pane="list-${tab}"] [data-article-id="${CSS.escape(id)}"]`);
      const target = row?.querySelector<HTMLElement>('[tabindex="0"]') ?? row;
      target?.focus({ preventScroll: true });
    };
    const focusReader = () => {
      const pane = paneRef.current;
      if (pane && !pane.contains(document.activeElement)) pane.focus({ preventScroll: true });
    };
    const opened = !!articleId && !prev.articleId;
    const closed = !articleId && !!prev.articleId;
    if (stacked) {
      if (opened || (articleId && prev.stacked === false)) focusReader();
      else if (closed) focusRow(prev.articleId);
      return;
    }
    // Two panes again with the article still open: only repair lost focus.
    if (articleId && prev.stacked === true) {
      const active = document.activeElement;
      if (!active || active === document.body) focusRow(articleId);
    }
  }, [articleId, stacked, paneRef]);
}
