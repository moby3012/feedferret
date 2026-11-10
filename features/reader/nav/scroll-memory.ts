"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

// Scroll memory keyed by URL (.pm/spec-shell-design.md §1.5). Reader open /
// close and pane switches need nothing (the DOM stays mounted); this covers a
// scope change inside one pane, the remount after /settings and reload.
// Key = canonical list URL without `a` (ListKey.id) · "sources" · "article:<id>".

export interface ScrollPos {
  top: number;
  anchorId?: string;
  /** Distance of the anchor row's top from the scroller's top edge. */
  anchorOffset?: number;
}

const STORAGE_KEY = "ff:scroll";
const MAX_ENTRIES = 50;
const memory = new Map<string, ScrollPos>();
let loaded = false;
let pagehideBound = false;

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as [string, ScrollPos][];
    if (Array.isArray(raw)) for (const [key, pos] of raw) if (typeof pos?.top === "number") memory.set(key, pos);
  } catch {
    /* corrupt or unavailable: start empty */
  }
}

export function persistScrollMemory() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...memory]));
  } catch {
    /* quota / private mode */
  }
}

export function rememberScroll(key: string, pos: ScrollPos) {
  load();
  memory.delete(key); // LRU: re-insert at the end
  memory.set(key, pos);
  while (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value!);
  if (!pagehideBound) {
    pagehideBound = true;
    window.addEventListener("pagehide", persistScrollMemory);
  }
}

export function recallScroll(key: string): ScrollPos | undefined {
  load();
  return memory.get(key);
}

function capture(scroller: HTMLElement): ScrollPos {
  const top = scroller.scrollTop;
  const rect = scroller.getBoundingClientRect();
  if (rect.width === 0 || top === 0) return { top };
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 2);
  const row = hit && scroller.contains(hit) ? (hit.closest("[data-article-id]") as HTMLElement | null) : null;
  const anchorId = row?.getAttribute("data-article-id") ?? undefined;
  if (!row || !anchorId) return { top };
  return { top, anchorId, anchorOffset: row.getBoundingClientRect().top - rect.top };
}

const anchorRow = (scroller: HTMLElement, id: string) => scroller.querySelector<HTMLElement>(`[data-article-id="${CSS.escape(id)}"]`);

function restore(scroller: HTMLElement, pos: ScrollPos | undefined): () => void {
  if (!pos) {
    if (scroller.scrollTop !== 0) scroller.scrollTo({ top: 0, behavior: "instant" });
    return () => {};
  }
  let top = pos.top;
  const row = pos.anchorId ? anchorRow(scroller, pos.anchorId) : null;
  if (row) top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - (pos.anchorOffset ?? 0);
  scroller.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  return row && pos.anchorId ? settleAnchor(scroller, pos.anchorId, pos.anchorOffset ?? 0) : () => {};
}

/**
 * Rows render lazily (`content-visibility:auto` with estimated heights), so
 * the rows around the restored offset change size in the next frames and
 * push the anchor away. Keep re-pinning the anchor until it is stable for a
 * few frames (≤ 30), and stop at once when the user starts scrolling.
 */
function settleAnchor(scroller: HTMLElement, anchorId: string, anchorOffset: number): () => void {
  let frame = 0;
  let frames = 0;
  let stable = 0;
  const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  const stop = () => {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    events.forEach((type) => scroller.removeEventListener(type, stop));
  };
  const tick = () => {
    frame = 0;
    const row = anchorRow(scroller, anchorId);
    if (!row || frames++ > 30) return stop();
    const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchorOffset;
    if (Math.abs(delta) > 1) {
      stable = 0;
      scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior: "instant" });
    } else if (++stable >= 3) {
      return stop();
    }
    frame = window.requestAnimationFrame(tick);
  };
  events.forEach((type) => scroller.addEventListener(type, stop, { passive: true }));
  frame = window.requestAnimationFrame(tick);
  return stop;
}

export type RestoreStep =
  | { kind: "ready" }
  /** Rows exist but too few are rendered: render at least `count` rows, then retry. */
  | { kind: "reveal"; count: number }
  /** The anchor row is not loaded yet: fetch the next page, then retry. */
  | { kind: "load" }
  /** Nothing to restore against yet (no rows / a page is in flight). */
  | { kind: "wait" };

export const MAX_RESTORE_LOADS = 10;

/**
 * Whether a remembered position can be restored against the rows the list
 * has (pure; unit-tested). Lists render a window of their loaded rows (30 at
 * first), so a deep offset must first reveal — or load — through its anchor
 * row; completing early would clamp the offset to the window's end.
 */
export function planRestore(
  pos: ScrollPos | undefined,
  ids: readonly string[],
  visibleCount: number,
  paging: { hasMorePages: boolean; isFetching: boolean; loads: number },
): RestoreStep {
  if (ids.length === 0) return paging.isFetching ? { kind: "wait" } : { kind: "ready" };
  if (!pos || pos.top <= 0) return { kind: "ready" };
  if (pos.anchorId) {
    const at = ids.indexOf(pos.anchorId);
    if (at >= 0) return at < visibleCount ? { kind: "ready" } : { kind: "reveal", count: at + 1 };
    if (paging.hasMorePages && paging.loads < MAX_RESTORE_LOADS) return paging.isFetching ? { kind: "wait" } : { kind: "load" };
  }
  // No anchor (or it is gone): the raw offset needs every loaded row rendered.
  return visibleCount < ids.length ? { kind: "reveal", count: ids.length } : { kind: "ready" };
}

/**
 * Gate for `useScrollMemory`'s `ready`: reveals / loads through the saved
 * anchor row before the restore runs. Latches per key — once restored, later
 * list changes never re-trigger reveals or page loads.
 */
export function useRestoreGate(
  key: string | null,
  ids: readonly string[],
  visibleCount: number,
  opts: { reveal: (count: number) => void; loadMore?: () => void; hasMorePages: boolean; isFetching: boolean },
): boolean {
  const latched = useRef<string | null>(null);
  const loads = useRef<{ key: string | null; n: number }>({ key: null, n: 0 });
  if (loads.current.key !== key) loads.current = { key, n: 0 };
  const step: RestoreStep =
    !key || latched.current === key
      ? { kind: "ready" }
      : planRestore(recallScroll(key), ids, visibleCount, { hasMorePages: opts.hasMorePages, isFetching: opts.isFetching, loads: loads.current.n });
  const ready = step.kind === "ready" && ids.length > 0;
  const revealCount = step.kind === "reveal" ? step.count : 0;
  const wantsLoad = step.kind === "load";
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useLayoutEffect(() => {
    if (ready && key) latched.current = key;
  }, [ready, key]);
  // Passive (not layout) and keyed on visibleCount too: the list resets its
  // window in a passive effect when its first row changes (initial load) —
  // a reveal must run after that and re-apply if the window was reset.
  useEffect(() => {
    if (revealCount > 0) optsRef.current.reveal(revealCount);
  }, [revealCount, visibleCount]);
  useEffect(() => {
    if (!wantsLoad) return;
    loads.current.n += 1;
    optsRef.current.loadMore?.();
  }, [wantsLoad, ids.length]);
  return ready;
}

/**
 * Remembers the scroll offset of `scroller` under `key` while it is bound and
 * restores it (anchor row first, raw offset as fallback, never animated) once
 * `ready` (rows exist) for a newly bound key. A key without memory starts at 0.
 */
export function useScrollMemory(scroller: HTMLElement | null, key: string | null, ready: boolean) {
  const restoredFor = useRef<string | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  const settling = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    if (!scroller || !key || !ready || restoredFor.current === key) return;
    restoredFor.current = key;
    settling.current();
    settling.current = restore(scroller, recallScroll(key));
  }, [scroller, key, ready]);
  useEffect(() => () => settling.current(), []);

  useEffect(() => {
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const current = keyRef.current;
        // Only once the bound key was restored: a stale offset must not overwrite the new key's memory.
        if (current && restoredFor.current === current) rememberScroll(current, capture(scroller));
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [scroller]);
}
