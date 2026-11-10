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
  /** Rows (stories, in grouped lists) created after the bound list's snapshot (head probe; 0 when not probed). */
  count: number;
  /** Replaces the snapshot with a fresh first page; `canCommit` is asked right before the write (see `useNewItemsProbe`). */
  apply(canCommit?: () => boolean): Promise<boolean>;
  /** One probe now; resolves with the new count (0 for lists without a probe). */
  recheck(): Promise<number>;
  /** An article of this tab is open in the reader: buffer only, never insert on its own. */
  readerOpen: boolean;
}

function readScroller(root: HTMLElement, readerOpen: boolean): ScrollerState {
  return { scrollTop: root.scrollTop, pointerDown: pointersDownCount() > 0, gestureActive: activeGesture() !== null, readerOpen };
}

/**
 * "↑ N neu" (spec §4.8). New rows are buffered: they enter the list only
 *   · silently, when the list is at the very top and nothing is under the
 *     finger (no pointer down, no gesture, scroll at rest, no article open in
 *     the reader) — checked when deciding AND again right before the fetched
 *     page is committed (a scroll / touch / reader opened while it was on the
 *     wire keeps the buffer), or
 *   · on a tap on the pill → inserted on top, then the list scrolls up.
 *
 * An explicit refresh (pull-to-refresh, "Aktualisieren", single-feed refresh)
 * always ends in an updated list, for every scope:
 *   · finished while idle at the top → applied right away (new rows on top,
 *     rows read meanwhile drop out of an unread list);
 *   · finished while scrolled / touching / reading → the pill shows "N neu",
 *     or "Aktualisieren" when the list has no count (search, oldest-first,
 *     "Recently read") or nothing new arrived; a tap applies, and so does
 *     coming back to rest at the top.
 * Existing rows never move while the user is scrolled down.
 *
 * Rendered as the scroller's first child: a sticky zero-height host, so
 * showing / hiding the pill never shifts a row.
 */
export function NewItemsPill({ scrollRoot, binding, refreshing }: { scrollRoot: HTMLElement | null; binding: NewItemsBinding; refreshing: boolean }) {
  const t = useTranslations("articleList");
  const [applying, setApplying] = useState(false);
  // An explicit refresh ended while inserting was not safe: an update is owed even with nothing new.
  const [refreshPending, setRefreshPending] = useState(false);
  const live = useRef({ binding, applying, refreshPending });
  live.current = { binding, applying, refreshPending };

  // Another list bound: what was owed to the previous one is void.
  const { apply } = binding;
  useEffect(() => {
    setRefreshPending(false);
  }, [apply]);

  const safeNow = useCallback(() => !!scrollRoot && canAutoApply(readScroller(scrollRoot, live.current.binding.readerOpen)), [scrollRoot]);

  const run = useCallback(
    async (mode: "silent" | "tap"): Promise<boolean> => {
      const root = scrollRoot;
      if (!root || live.current.applying) return false;
      const from = root.scrollTop;
      const viewport = root.clientHeight;
      setApplying(true);
      live.current.applying = true;
      try {
        // Silent: the user may have scrolled, touched or opened an article while the page was on the wire.
        const applied = await live.current.binding.apply(mode === "silent" ? safeNow : undefined);
        if (!applied) return false;
        live.current.refreshPending = false;
        setRefreshPending(false);
        if (mode === "tap") {
          // After the new rows rendered: back to the top.
          requestAnimationFrame(() => root.scrollTo({ top: 0, behavior: scrollBehaviorFor(from, viewport) }));
        }
        return true;
      } catch {
        if (mode === "tap") toast.error(t("newItemsFailed"));
        return false;
      } finally {
        live.current.applying = false;
        setApplying(false);
      }
    },
    [scrollRoot, safeNow, t],
  );

  const waiting = () => live.current.binding.count > 0 || live.current.refreshPending;

  // Idle at the very top with something waiting → insert without asking.
  const maybeAutoApply = useCallback(() => {
    if (!scrollRoot || live.current.applying || !waiting()) return;
    const s = readScroller(scrollRoot, live.current.binding.readerOpen);
    if (bufferDecision(1, s) === "apply") void run("silent");
  }, [scrollRoot, run]);

  const count = binding.count;
  const readerOpen = binding.readerOpen;
  // A new count, or the reader closed (rows may enter again).
  useEffect(() => {
    if (count > 0 || !readerOpen) maybeAutoApply();
  }, [count, readerOpen, maybeAutoApply]);

  // Arriving at the top later (scroll comes to rest, finger lifts) applies a waiting buffer.
  useEffect(() => {
    if (!scrollRoot) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      if (waiting()) timer = setTimeout(maybeAutoApply, SCROLL_IDLE_MS);
    };
    scrollRoot.addEventListener("scroll", settle, { passive: true });
    document.addEventListener("pointerup", settle, { passive: true });
    document.addEventListener("pointercancel", settle, { passive: true });
    return () => {
      clearTimeout(timer);
      scrollRoot.removeEventListener("scroll", settle);
      document.removeEventListener("pointerup", settle);
      document.removeEventListener("pointercancel", settle);
    };
  }, [scrollRoot, maybeAutoApply]);

  // An explicit refresh ended: probe once more, then apply if safe — otherwise owe an update.
  const wasRefreshing = useRef(refreshing);
  useEffect(() => {
    const ended = wasRefreshing.current && !refreshing;
    wasRefreshing.current = refreshing;
    if (!ended || !scrollRoot) return;
    let cancelled = false;
    void (async () => {
      await live.current.binding.recheck().catch(() => 0);
      if (cancelled) return;
      if (safeNow() && (await run("silent"))) return;
      if (cancelled) return;
      live.current.refreshPending = true;
      setRefreshPending(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshing, scrollRoot, run, safeNow]);

  const visible = count > 0 || refreshPending;
  const label = formatNewCount(count);
  return (
    <div className="ff-new-pill-host">
      <button
        type="button"
        className="ff-new-pill hit-slop"
        data-testid="new-items-pill"
        data-state={visible ? "visible" : "hidden"}
        data-count={count}
        data-kind={count > 0 ? "count" : "refresh"}
        aria-hidden={visible ? undefined : true}
        tabIndex={visible ? undefined : -1}
        aria-busy={applying || undefined}
        aria-label={count > 0 ? t("newItemsAria", { count }) : t("newItemsRefreshAria")}
        disabled={applying}
        onClick={() => void run("tap")}
      >
        <ArrowUp className="size-3.5" aria-hidden />
        <span>{count > 0 ? t("newItems", { count: label }) : t("newItemsRefresh")}</span>
      </button>
    </div>
  );
}
