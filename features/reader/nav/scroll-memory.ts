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

function restore(scroller: HTMLElement, pos: ScrollPos | undefined) {
  if (!pos) {
    if (scroller.scrollTop !== 0) scroller.scrollTo({ top: 0, behavior: "instant" });
    return;
  }
  let top = pos.top;
  if (pos.anchorId) {
    const row = scroller.querySelector<HTMLElement>(`[data-article-id="${CSS.escape(pos.anchorId)}"]`);
    if (row) top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - (pos.anchorOffset ?? 0);
  }
  scroller.scrollTo({ top: Math.max(0, top), behavior: "instant" });
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

  useLayoutEffect(() => {
    if (!scroller || !key || !ready || restoredFor.current === key) return;
    restoredFor.current = key;
    restore(scroller, recallScroll(key));
  }, [scroller, key, ready]);

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
