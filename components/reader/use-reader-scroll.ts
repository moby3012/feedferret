"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { createPull, PULL_TRIGGER_PX } from "@/lib/gestures";
import { readReaderPosition, saveReaderPosition } from "@/features/reader/reader-position";

// Everything the reader does with its scroller, all outside React renders:
// the hide-on-scroll top bar + reading progress (one rAF writer on the root's
// data attributes / custom properties), the per-article position memory and
// the tracked pull-past-end to the next article.

const HIDE_AFTER_PX = 80; // only below this offset
const HIDE_RUN_PX = 24; // continuous downward scroll before hiding
const SHOW_RUN_PX = 12; // upward scroll that brings the bar back
const END_SLACK_PX = 2;

function maxScroll(el: HTMLElement) {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

/**
 * Top bar hide-on-scroll (spec §4.7) + progress. Writes `data-chrome` =
 * shown|hidden and `--reader-progress` (0–1) on `root`. The bar stays while
 * focus is inside it or one of its menus/popovers is open.
 */
export function useReaderChrome(
  rootRef: RefObject<HTMLElement | null>,
  scrollerRef: RefObject<HTMLElement | null>,
  barRef: RefObject<HTMLElement | null>,
  articleId: string | null,
) {
  useEffect(() => {
    const root = rootRef.current;
    const scroller = scrollerRef.current;
    if (!root || !scroller) return;
    let hidden = false;
    let lastY = scroller.scrollTop;
    let down = 0;
    let up = 0;
    let frame = 0;
    const set = (h: boolean) => {
      if (h === hidden) return;
      hidden = h;
      root.dataset.chrome = h ? "hidden" : "shown";
    };
    const pinned = () => {
      const bar = barRef.current;
      return !!bar && (bar.contains(document.activeElement) || !!bar.querySelector('[aria-expanded="true"]'));
    };
    const update = () => {
      frame = 0;
      const y = scroller.scrollTop;
      const max = maxScroll(scroller);
      root.style.setProperty("--reader-progress", max > 0 ? Math.min(1, Math.max(0, y / max)).toFixed(4) : "0");
      const dy = y - lastY;
      lastY = y;
      if (y <= HIDE_AFTER_PX || y >= max - END_SLACK_PX) {
        down = up = 0;
        set(false);
        return;
      }
      // A jump of a viewport or more in one frame is programmatic (position
      // restore, scroll-to-top), not reading: it neither hides nor shows.
      if (Math.abs(dy) >= scroller.clientHeight) {
        down = up = 0;
        return;
      }
      if (dy > 0) {
        down += dy;
        up = 0;
        if (down >= HIDE_RUN_PX && !pinned()) set(true);
      } else if (dy < 0) {
        up -= dy;
        down = 0;
        if (up >= SHOW_RUN_PX) set(false);
      }
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (barRef.current?.contains(e.target as Node)) set(false);
    };
    root.dataset.chrome = "shown";
    // First measurement in the next frame: no forced layout inside the tap's task.
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("focusin", onFocusIn);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
      root.removeEventListener("focusin", onFocusIn);
    };
  }, [rootRef, scrollerRef, barRef, articleId]);
}

/**
 * Per-article scroll position: every article opens at the top unless it was
 * read partway within the last 24 h, then it reopens there. The position is
 * re-applied while the body/images still change the height, until the user
 * scrolls; it is saved only after the user has interacted with the scroller.
 */
export function useReaderPosition(scrollerRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>, articleId: string | null) {
  const interacted = useRef(false);
  const shownBefore = useRef(false);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !articleId) return;
    interacted.current = false;
    const target = readReaderPosition(articleId);
    // A fresh scroller is at the top already; touching scrollTop would force a
    // layout inside the tap's task. Article → article reuses the scroller.
    if (shownBefore.current || target !== null) scroller.scrollTop = 0;
    shownBefore.current = true;
    let settled = target === null;
    const apply = () => {
      if (settled || interacted.current) return;
      const max = maxScroll(scroller);
      if (max > 0) scroller.scrollTop = Math.round(target! * max);
    };
    apply();

    const markInteraction = () => {
      interacted.current = true;
    };
    // The ratio is captured at scroll time: by the time the cleanup flushes
    // (next article committed), the scroller already holds other content.
    let saveTimer = 0;
    let ratio: number | null = null;
    const save = () => {
      saveTimer = 0;
      if (ratio !== null) saveReaderPosition(articleId, ratio);
    };
    const onScroll = () => {
      if (!interacted.current) return;
      const max = maxScroll(scroller);
      if (max > 0) ratio = scroller.scrollTop / max;
      if (!saveTimer) saveTimer = window.setTimeout(save, 250);
    };
    const opts = { passive: true } as const;
    scroller.addEventListener("pointerdown", markInteraction, opts);
    scroller.addEventListener("touchstart", markInteraction, opts);
    scroller.addEventListener("wheel", markInteraction, opts);
    scroller.addEventListener("keydown", markInteraction);
    scroller.addEventListener("scroll", onScroll, opts);

    // Body (lazy chunk / late detail) and images grow the page after open.
    const content = contentRef.current;
    const ro = !settled && content && typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    if (ro && content) ro.observe(content);
    const stopTimer = window.setTimeout(() => {
      settled = true;
      ro?.disconnect();
    }, 2500);

    return () => {
      window.clearTimeout(stopTimer);
      ro?.disconnect();
      scroller.removeEventListener("pointerdown", markInteraction);
      scroller.removeEventListener("touchstart", markInteraction);
      scroller.removeEventListener("wheel", markInteraction);
      scroller.removeEventListener("keydown", markInteraction);
      scroller.removeEventListener("scroll", onScroll);
      if (saveTimer) {
        window.clearTimeout(saveTimer);
        save();
      }
    };
  }, [scrollerRef, contentRef, articleId]);
}

/**
 * Tracked pull past the end of the article → next article (touch only), on
 * the shared `createPull` (lib/gestures: pannable-content guard, axis lock,
 * second-finger cancel, haptics, spring back). Writes `--pull-p` (pull after
 * resistance / trigger distance; ≥1 = armed) and `data-pull` =
 * idle|tracking|armed on `indicator`; no React renders during the drag.
 */
export function usePullToNext(
  scrollerRef: RefObject<HTMLElement | null>,
  indicatorRef: RefObject<HTMLElement | null>,
  enabledRef: RefObject<boolean>,
  onTriggerRef: RefObject<() => void>,
) {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    return createPull(scroller, {
      edge: "bottom",
      enabled: () => enabledRef.current,
      onTrigger: () => onTriggerRef.current(),
      render: (px, state) => {
        const indicator = indicatorRef.current;
        if (!indicator) return;
        indicator.style.setProperty("--pull-p", (px / PULL_TRIGGER_PX).toFixed(3));
        indicator.dataset.pull = state === "pulling" ? "tracking" : state;
      },
    });
  }, [scrollerRef, indicatorRef, enabledRef, onTriggerRef]);
}
