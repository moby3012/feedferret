// "↑ N neu" (spec §4.8, research-reeder adoptions 2/3/5): pure rules of the
// head probe and of the buffered apply. New rows are never written into a
// bound list on their own; they are counted by the probe and inserted only
// when the user asks (pill, pull-to-refresh) or is idle at the very top.

import type { InfiniteData, QueryCacheNotifyEvent } from "@tanstack/react-query";
import type { ListKey } from "./scope";
import type { ArticleListItem, ArticlePage, HeadProbe } from "./types";

export const EMPTY_HEAD: HeadProbe = { count: 0, newestCursor: null };

/** Above this the pill reads "99+" (the server caps the count at 100). */
export const NEW_COUNT_CAP = 99;

/** Scroller offset that still counts as "at the very top" (spec §4.8). */
export const AT_TOP_PX = 8;

export function formatNewCount(n: number): string {
  return n > NEW_COUNT_CAP ? `${NEW_COUNT_CAP}+` : String(Math.max(0, n));
}

/** Lists that are a newest-first timeline of arrivals. Search and "Recently read" never get a pill. */
export function probeApplies(key: ListKey | null): key is ListKey {
  return !!key && key.sort === "new" && key.scopeKey !== "v:recent" && !key.scopeKey.startsWith("q:");
}

/**
 * The probe's lower bound: the list snapshot's server time, raised to the
 * newest `createdAt` already shown — a row synced while the first page was
 * being read is past `snapshotAt` but already on screen and must not be
 * counted as new.
 */
export function probeSince(snapshotAt: number | null, items: ReadonlyArray<Pick<ArticleListItem, "createdAt">>): number | null {
  if (snapshotAt == null) return null;
  let since = snapshotAt;
  for (const item of items) {
    const t = Date.parse(item.createdAt);
    if (Number.isFinite(t) && t > since) since = t;
  }
  return since;
}

/** `GET /api/app/articles/head` URL of a list key (its canonical id carries the scope params). */
export function headUrl(key: ListKey, since: number): string {
  const params = new URLSearchParams(key.id.startsWith("/?") ? key.id.slice(2) : "");
  params.set("show", key.show);
  params.set("sort", key.sort);
  params.set("since", String(Math.trunc(since)));
  return `/api/app/articles/head?${params.toString()}`;
}

export interface ScrollerState {
  scrollTop: number;
  /** A pointer (finger, mouse button) is down on the list. */
  pointerDown: boolean;
  /** A row gesture (swipe, long-press, pull) is in progress. */
  gestureActive: boolean;
}

/**
 * New rows may be inserted without asking only when nothing can move under
 * the user: the list is at the very top and no pointer / gesture is active.
 */
export function canAutoApply(s: ScrollerState): boolean {
  return s.scrollTop <= AT_TOP_PX && !s.pointerDown && !s.gestureActive;
}

/** Scroll back up smoothly only over a short distance (< 3 viewports); jump otherwise. */
export function scrollBehaviorFor(scrollTop: number, viewportHeight: number): ScrollBehavior {
  return scrollTop < 3 * Math.max(1, viewportHeight) ? "smooth" : "instant";
}

/**
 * The applied list: a fresh first page replaces the snapshot (pages beyond it
 * are dropped — the list goes back to the top, older rows page in again).
 */
export function appliedListData(page: ArticlePage): InfiniteData<ArticlePage, string | null> {
  return { pages: [page], pageParams: [null] };
}

/** What the list shows for a probe answer: nothing (0), the pill, or an immediate silent insert. */
export function bufferDecision(count: number, scroller: ScrollerState | null): "none" | "pill" | "apply" {
  if (count <= 0) return "none";
  return scroller && canAutoApply(scroller) ? "apply" : "pill";
}

/**
 * The probe's trigger: a real counts response (poll, focus, reconnect, after
 * a sync) — not an optimistic `setQueryData` on the counts (`manual`).
 */
export function isCountsFetch(event: QueryCacheNotifyEvent): boolean {
  return event.type === "updated" && event.action.type === "success" && !event.action.manual && event.query.queryKey[0] === "counts";
}
