"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowUp } from "lucide-react";
import { toast } from "sonner";
import { bufferDecision, canAutoApply, formatNewCount, scrollBehaviorFor, type ScrollerState } from "@/features/articles/new-items";
import { activeGesture, pointersDownCount } from "@/lib/gestures/guards";

/** A scroll is over when no `scroll` event came for this long (no reliance on `scrollend`). */
const SCROLL_IDLE_MS = 160;

export interface NewItemsBinding {
  /** Rows created after the bound list's snapshot (head probe). */
  count: number;
  /** Replaces the snapshot with a fresh first page (see `useNewItemsProbe`). */
  apply(): Promise<void>;
}

function readScroller(root: HTMLElement): ScrollerState {
  return { scrollTop: root.scrollTop, pointerDown: pointersDownCount() > 0, gestureActive: activeGesture() !== null };
}

/**
 * "↑ N neu" (spec §4.8). New rows are buffered: they enter the list only
 *   · silently, when the list is at the very top and nothing is under the
 *     finger (no pointer down, no gesture, scroll at rest), or
 *   · on a tap on the pill → inserted on top, then the list scrolls up.
 * A refresh (pull-to-refresh, "Aktualisieren") that finishes while the user
 * is at the top applies too; finished further down, its new rows wait behind
 * the pill. Existing rows never move while the user is scrolled down.
 *
 * Rendered as the scroller's first child: a sticky zero-height host, so
 * showing / hiding the pill never shifts a row.
 */
export function NewItemsPill({ scrollRoot, binding, refreshing }: { scrollRoot: HTMLElement | null; binding: NewItemsBinding; refreshing: boolean }) {
  const t = useTranslations("articleList");
  const [applying, setApplying] = useState(false);
  const live = useRef({ binding, applying });
  live.current = { binding, applying };

  const run = useCallback(
    async (mode: "silent" | "tap") => {
      const root = scrollRoot;
      if (!root || live.current.applying) return;
      const from = root.scrollTop;
      const viewport = root.clientHeight;
      setApplying(true);
      live.current.applying = true;
      try {
        await live.current.binding.apply();
        if (mode === "tap") {
          // After the new rows rendered: back to the top.
          requestAnimationFrame(() => root.scrollTo({ top: 0, behavior: scrollBehaviorFor(from, viewport) }));
        }
      } catch {
        if (mode === "tap") toast.error(t("newItemsFailed"));
      } finally {
        live.current.applying = false;
        setApplying(false);
      }
    },
    [scrollRoot, t],
  );

  // Idle at the very top → insert without asking.
  const maybeAutoApply = useCallback(() => {
    if (!scrollRoot || live.current.applying) return;
    if (bufferDecision(live.current.binding.count, readScroller(scrollRoot)) === "apply") void run("silent");
  }, [scrollRoot, run]);

  const count = binding.count;
  useEffect(() => {
    if (count > 0) maybeAutoApply();
  }, [count, maybeAutoApply]);

  // Arriving at the top later (scroll comes to rest, finger lifts) applies a waiting buffer.
  useEffect(() => {
    if (!scrollRoot) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(timer);
      if (live.current.binding.count > 0) timer = setTimeout(maybeAutoApply, SCROLL_IDLE_MS);
    };
    const onPointerUp = () => {
      clearTimeout(timer);
      if (live.current.binding.count > 0) timer = setTimeout(maybeAutoApply, SCROLL_IDLE_MS);
    };
    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("pointerup", onPointerUp, { passive: true });
    document.addEventListener("pointercancel", onPointerUp, { passive: true });
    return () => {
      clearTimeout(timer);
      scrollRoot.removeEventListener("scroll", onScroll);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
    };
  }, [scrollRoot, maybeAutoApply]);

  // A refresh that ends while the user is idle at the top shows its result right away.
  const wasRefreshing = useRef(refreshing);
  useEffect(() => {
    const ended = wasRefreshing.current && !refreshing;
    wasRefreshing.current = refreshing;
    if (ended && scrollRoot && canAutoApply(readScroller(scrollRoot))) void run("silent");
  }, [refreshing, scrollRoot, run]);

  const visible = count > 0;
  const label = formatNewCount(count);
  return (
    <div className="ff-new-pill-host">
      <button
        type="button"
        className="ff-new-pill hit-slop"
        data-testid="new-items-pill"
        data-state={visible ? "visible" : "hidden"}
        data-count={count}
        aria-hidden={visible ? undefined : true}
        tabIndex={visible ? undefined : -1}
        aria-busy={applying || undefined}
        aria-label={t("newItemsAria", { count })}
        disabled={applying}
        onClick={() => void run("tap")}
      >
        <ArrowUp className="size-3.5" aria-hidden />
        <span>{t("newItems", { count: label })}</span>
      </button>
    </div>
  );
}
