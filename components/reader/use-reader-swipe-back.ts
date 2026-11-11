"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { completeBackHint, createBackSwipe, documentDir, getGesturePrefs } from "@/lib/gestures";
import { useReaderStacked } from "@/features/reader/layout/layout-class";
import { getNavState, nav } from "@/features/reader/nav/store";

/**
 * At gesture start: does the (resting, open) reader pane actually cover the
 * list? Geometry, not breakpoints, so every stacked layout (compact, and
 * portrait tablets where the reader pushes over the list) gets swipe-back and
 * two-pane layouts never do.
 */
function readerCoversList(pane: HTMLElement): boolean {
  const list = coveredList();
  if (!list) return false;
  const r = pane.getBoundingClientRect();
  const l = list.getBoundingClientRect();
  return r.left < l.right - 1 && r.right > l.left + 1;
}

/** The reader is a layer over the list (compact + portrait tablets) — for post-mount widgets (the tip). */
export function useReaderOverList(): boolean {
  return useReaderStacked() === true;
}

/** The active list pane the reader covers (it moves with a parallax lag under the drag). */
function coveredList(): HTMLElement | null {
  const tab = getNavState().loc.tab;
  return document.querySelector<HTMLElement>(`.ff-shell > [data-pane="list-${tab}"]`);
}

/**
 * Open UI above the reader that Back would close first: a nav overlay ("Aa",
 * "…", context menus, palette — features/reader/nav/overlays.ts) or any other
 * open dialog / menu / sheet (share fallbacks, confirms, Radix + vaul layers).
 */
const OPEN_LAYER_SELECTOR =
  '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"]), [role="menu"]:not([data-state="closed"]), [role="listbox"]:not([data-state="closed"]), [data-vaul-drawer]:not([data-state="closed"])';

export function overlayOpen(): boolean {
  if (getNavState().overlay) return true;
  return typeof document !== "undefined" && document.querySelector(OPEN_LAYER_SELECTOR) !== null;
}

/** Never longer than this between a committed swipe and the reader actually closing. */
const CLOSE_TIMEOUT_MS = 1200;

/**
 * Reader swipe-back (lib/gestures/back-swipe.ts) on the reader pane: a swipe
 * towards inline-end goes up one level — `nav.up()`, the same op as the back
 * chevron (history.back() when the article pushed an entry, so system Back
 * never needs a second press). The slid-out visual state is kept until the
 * article is closed (no flash back in), then cleared in the closing commit.
 * Returns a ref that is `true` once a swipe closed the article (the pane is
 * already out of view: the caller skips waiting for its close transition).
 */
export function useReaderSwipeBack(paneRef: RefObject<HTMLElement | null>, articleId: string | null): RefObject<boolean> {
  const handle = useRef<ReturnType<typeof createBackSwipe> | null>(null);
  const swiped = useRef(false);
  const openRef = useRef(articleId);
  openRef.current = articleId;

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const h = createBackSwipe(pane, {
      enabled: () => !!openRef.current && getGesturePrefs().swipeBack && readerCoversList(pane),
      dir: documentDir,
      under: coveredList,
      blocked: overlayOpen,
      onStart: completeBackHint,
      onCommit: () => {
        const id = openRef.current;
        swiped.current = true;
        void nav.up();
        // Something kept the article open (an overlay took the Back): put the reader back.
        closeTimer = setTimeout(() => {
          if (openRef.current && openRef.current === id) {
            swiped.current = false;
            h.reset();
          }
        }, CLOSE_TIMEOUT_MS);
      },
    });
    handle.current = h;
    return () => {
      if (closeTimer !== null) clearTimeout(closeTimer);
      handle.current = null;
      h.destroy();
    };
  }, [paneRef]);

  // Closed (or another article opened): the swipe's inline styles go in the same commit.
  useLayoutEffect(() => {
    handle.current?.reset();
    if (articleId) swiped.current = false;
  }, [articleId]);
  return swiped;
}
