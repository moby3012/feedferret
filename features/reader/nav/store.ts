"use client";

// Nav store: the URL + history are the source of truth for tab, scope, show,
// query and the open article (.pm/spec-shell-design.md §1.4). Components read
// it with `useNav(selector)` and change it only through `nav.*`; in-shell
// navigation never calls router.push/replace (no RSC round-trip).
import { createContext, createElement, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { showApplies } from "@/features/articles/scope";
import { getLayoutClass, isCoarsePointer, subscribeLayoutClass } from "../layout/layout-class";
import { isIOS, keepFfAcrossRouterWrites, pushEntry, readFf, replaceEntry, setNavAnim, whenRouterReady, type FfState } from "./history";
import {
  TAB_ROOTS,
  entryKindOf,
  formatLoc,
  locOf,
  normalizeSearch,
  parentOf,
  parseLoc,
  sameLoc,
  stackOf,
  type Loc,
  type LocIntents,
  type NavLayout,
  type Scope,
  type Show,
  type TabId,
} from "./location";
import type { OverlayId } from "./overlays";

export type NavCause = "init" | "push" | "replace" | "pop-ui" | "pop-os" | "tab";

export interface NavState {
  loc: Loc;
  overlay: OverlayId | null;
  /** App-pushed entries beneath the current one (`history.state.ff.i`). */
  index: number;
  cause: NavCause;
}

const FALLBACK: NavState = { loc: TAB_ROOTS.new, overlay: null, index: 0, cause: "init" };
const POP_FALLBACK_MS = 300;

let state: NavState | null = null;
const listeners = new Set<() => void>();
let pending: { resolve: () => void; timer: number } | null = null;
let searchReturn: Loc | null = null;
let queue: Promise<void> | null = null;
/** Layout family the owned history stack was last written for (compact has the Feeds root level). */
let stackLayout: NavLayout | null = null;
/** A reconcile pass is queued and has not started yet. */
let reconcileQueued = false;

const searchOf = (href: string) => href.split("?")[1] ?? "";
const navLayout = (): NavLayout => (getLayoutClass() === "compact" ? "compact" : "wide");

function readState(cause: NavCause): NavState {
  const ff = readFf();
  return { loc: parseLoc(window.location.search), overlay: ff?.k === "overlay" ? (ff.o ?? null) : null, index: ff?.i ?? 0, cause };
}

export function getNavState(): NavState {
  if (!state) state = typeof window === "undefined" ? FALLBACK : { ...readState("init"), overlay: null };
  return state;
}

export function subscribeNav(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ------------------------------------------------------------ tab memory
const TABS_KEY = "ff:tabs";
let tabMemory: Partial<Record<TabId, string>> | null = null;

function tabs(): Partial<Record<TabId, string>> {
  if (tabMemory) return tabMemory;
  try {
    tabMemory = JSON.parse(sessionStorage.getItem(TABS_KEY) ?? "{}") ?? {};
  } catch {
    tabMemory = {};
  }
  return tabMemory!;
}

function rememberTab(loc: Loc) {
  const memory = tabs();
  const href = formatLoc({ ...loc, articleId: null });
  if (memory[loc.tab] === href) return;
  memory[loc.tab] = href;
  try {
    sessionStorage.setItem(TABS_KEY, JSON.stringify(memory));
  } catch {
    /* private mode: memory stays in-process */
  }
}

/** Last location of a tab (without article); the tab root if none. */
export function tabMemoryLoc(tab: TabId): Loc {
  const href = tabs()[tab];
  const loc = href ? parseLoc(searchOf(href)) : null;
  return loc && loc.tab === tab ? loc : TAB_ROOTS[tab];
}

// ------------------------------------------------------------ primitives
function commit(next: NavState) {
  state = next;
  rememberTab(next.loc);
  listeners.forEach((listener) => listener());
}

function write(mode: "push" | "replace", loc: Loc, ff: FfState) {
  const url = formatLoc(loc);
  if (mode === "push") pushEntry(url, ff);
  else replaceEntry(url, ff);
}

/** history.go(delta) and wait for its popstate (which is then not treated as a user navigation). */
function goAndWait(delta: number): Promise<void> {
  return new Promise((resolve) => {
    if (pending) {
      window.clearTimeout(pending.timer);
      pending.resolve();
    }
    const timer = window.setTimeout(() => {
      pending = null;
      resolve();
    }, POP_FALLBACK_MS);
    pending = { resolve, timer };
    window.history.go(delta);
  });
}

/**
 * Serializes ops; a sync op on an idle queue runs (and paints) in the same
 * task. Every op first brings the owned stack in line with the current
 * layout (no-op unless the compact breakpoint was crossed).
 */
function run(task: () => void | Promise<void>): Promise<void> {
  const op = () => after(reconcileLayoutInner(), task);
  if (!queue) {
    const result = op();
    if (!result) return Promise.resolve();
    const p: Promise<void> = result.finally(() => {
      if (queue === p) queue = null;
    });
    queue = p;
    return p;
  }
  const p: Promise<void> = queue.then(op).finally(() => {
    if (queue === p) queue = null;
  });
  queue = p;
  return p;
}

function onPopState() {
  if (pending) {
    const p = pending;
    pending = null;
    window.clearTimeout(p.timer);
    p.resolve();
    return;
  }
  if (window.location.pathname !== "/") return; // traversal to another route: Next unmounts the shell
  // Our own traversals (UI back, stack resets) are awaited via `pending`:
  // whatever arrives here is the OS / browser (edge-swipe, back key, Alt+←).
  const next = readState("pop-os");
  if (!readFf()) replaceEntry(formatLoc(next.loc), { i: 0, k: entryKindOf(next.loc, navLayout()) });
  // iOS already animated its edge-swipe: never play our pop on top of it.
  setNavAnim(next.cause === "pop-os" && isIOS() ? "none" : "pop");
  commit(next);
}

// ------------------------------------------------------------ inner ops (no queue)
/** Drops an open overlay before a navigation (its history entry is popped first). */
function dropOverlay(): void | Promise<void> {
  const s = getNavState();
  if (!s.overlay) return;
  if (readFf()?.k === "overlay") {
    return goAndWait(-1).then(() => {
      state = { ...readState("pop-ui"), overlay: null };
    });
  }
  state = { ...s, overlay: null };
}

/** UI-initiated back: wait for the traversal, then publish the landed entry. */
function popBack(): Promise<void> {
  return goAndWait(-1).then(() => {
    setNavAnim("pop");
    commit(readState("pop-ui"));
  });
}

function after(first: void | Promise<void>, next: () => void | Promise<void>): void | Promise<void> {
  return first ? first.then(next) : next();
}

/**
 * Rewrites the owned stack as the chain of `target`. The chain is computed
 * AFTER the traversal to the bottom entry, for the layout at that moment: a
 * resize while the traversal is awaited must not leave a chain of the old
 * layout recorded as the new one (`stackLayout` is what the chain was built for).
 */
async function resetStackInner(target: Loc) {
  const s = getNavState();
  if (s.index > 0) await goAndWait(-s.index);
  const layout = navLayout();
  const entries = stackOf(target, layout);
  stackLayout = layout;
  entries.forEach((loc, j) => write(j === 0 ? "replace" : "push", loc, { i: j, k: entryKindOf(loc, layout) }));
  setNavAnim("none");
  commit({ loc: entries[entries.length - 1], overlay: null, index: entries.length - 1, cause: "tab" });
}

/** Same depth → replace; from an article/overlay entry → reset the stack (the level is dropped). */
function replaceOrReset(target: Loc): void | Promise<void> {
  const s = getNavState();
  const layout = navLayout();
  if (s.index > 0 && (s.loc.articleId || readFf()?.k === "overlay")) return resetStackInner(target);
  write("replace", target, { i: s.index, k: entryKindOf(target, layout) });
  setNavAnim("none");
  commit({ loc: target, overlay: null, index: s.index, cause: "replace" });
}

function stepInner(id: string) {
  const s = getNavState();
  if (s.loc.articleId === id) return;
  const loc = { ...s.loc, articleId: id };
  write("replace", loc, { i: s.index, k: "article" });
  setNavAnim("none");
  commit({ ...s, loc, cause: "replace" });
}

function openInner(id: string) {
  const s = getNavState();
  if (s.loc.articleId) return stepInner(id);
  const loc = { ...s.loc, articleId: id };
  const index = s.index + 1;
  write("push", loc, { i: index, k: "article" });
  setNavAnim("push");
  commit({ loc, overlay: null, index, cause: "push" });
}

function upInner(): void | Promise<void> {
  const s = getNavState();
  if (s.overlay) return closeOverlayInner();
  if (s.index > 0) return popBack();
  // Cold deep link without seeded parent (or a stack we no longer own): replace.
  const parent = parentOf(s.loc, navLayout());
  if (!parent) return;
  write("replace", parent, { i: 0, k: entryKindOf(parent, navLayout()) });
  setNavAnim("pop");
  commit({ loc: parent, overlay: null, index: 0, cause: "replace" });
}

function closeOverlayInner() {
  const s = getNavState();
  if (!s.overlay) return;
  if (readFf()?.k === "overlay") return popBack();
  commit({ ...s, overlay: null, cause: "replace" });
}

/**
 * Crossing the compact breakpoint changes the depth of a location (compact
 * has the Feeds root level beneath a feed). Rewrite the owned stack for the
 * new layout so Back stays one level up — e.g. a wide deep link `/?feed=F`
 * resized to compact must Back to the Feeds root, not out of the app. An open
 * overlay survives (it is re-opened on top of the rewritten stack).
 */
function reconcileLayoutInner(): void | Promise<void> {
  reconcileQueued = false; // a crossing from here on (even mid-traversal) queues the next pass
  const layout = navLayout();
  if (stackLayout === null || layout === stackLayout) return;
  stackLayout = layout;
  const s = getNavState();
  const onOverlayEntry = readFf()?.k === "overlay";
  const depth = s.index - (onOverlayEntry ? 1 : 0);
  const chain = stackOf(s.loc, layout);
  if (depth === chain.length - 1) {
    // Same depth: only the entry kinds may differ ("scope" ⇄ "root").
    if (!onOverlayEntry) replaceEntry(formatLoc(s.loc), { i: s.index, k: entryKindOf(s.loc, layout) });
    return;
  }
  const overlay = s.overlay;
  // The chain is rebuilt for the layout at the END of the traversal (see
  // resetStackInner); a later crossing is picked up by the queued pass.
  return resetStackInner(s.loc).then(() => {
    if (overlay) openOverlayInner(overlay);
  });
}

/** Layout listener: one queued reconcile pass at a time (latest layout wins when it runs). */
function scheduleReconcile() {
  if (reconcileQueued || stackLayout === null || navLayout() === stackLayout) return;
  reconcileQueued = true;
  void run(() => {}); // every op starts with reconcileLayoutInner()
}

function openOverlayInner(id: OverlayId) {
  const s = getNavState();
  if (s.overlay === id) return;
  const ff = readFf();
  if (s.overlay && ff?.k === "overlay") {
    // Overlays never nest: swap the one that is open.
    replaceEntry(formatLoc(s.loc), { ...ff, o: id });
    commit({ ...s, overlay: id, cause: "replace" });
    return;
  }
  if (navLayout() === "compact" || isCoarsePointer()) {
    const index = s.index + 1;
    pushEntry(formatLoc(s.loc), { i: index, k: "overlay", o: id });
    commit({ ...s, overlay: id, index, cause: "push" });
  } else {
    commit({ ...s, overlay: id, cause: "replace" });
  }
}

function goScopeInner(scope: Scope, show: Show): void | Promise<void> {
  const s = getNavState();
  const target = locOf(scope, show);
  if (sameLoc(target, s.loc)) return;
  if (navLayout() === "wide") return replaceOrReset(target);
  // compact: Feeds root → scope drills one level down.
  if (!s.loc.articleId && s.loc.tab === "feeds" && !s.loc.scope && target.tab === "feeds") {
    const index = s.index + 1;
    write("push", target, { i: index, k: "scope" });
    setNavAnim("push");
    commit({ loc: target, overlay: null, index, cause: "push" });
    return;
  }
  if (!s.loc.articleId && target.tab === s.loc.tab) return replaceOrReset(target);
  // Cross-tab jump (or leaving the reader for another list): fresh stack of the target tab.
  return resetStackInner(target);
}

function setQueryInner(q: string): void | Promise<void> {
  const s = getNavState();
  const text = q.trim();
  if (text) {
    if (s.loc.tab !== "search") searchReturn = { ...s.loc, articleId: null };
    const target = locOf({ kind: "query", q: text });
    if (sameLoc(target, s.loc)) return;
    return replaceOrReset(target);
  }
  if (s.loc.tab !== "search") return;
  const target = searchReturn ?? TAB_ROOTS.new;
  searchReturn = null;
  return replaceOrReset(target);
}

// ------------------------------------------------------------ public API
export const nav = {
  /** Open an article: push when none is open, replace when one is (j/k, prev/next, another row). */
  openArticle: (id: string) => run(() => after(dropOverlay(), () => openInner(id))),
  /** Article → article: always replace (history length never grows). */
  stepArticle: (id: string) => run(() => stepInner(id)),
  closeArticle: () => run(() => (getNavState().loc.articleId ? upInner() : undefined)),
  /** One level up: overlay → article → scope; history.back() when the level was pushed. */
  up: () => run(() => upInner()),
  goScope: (scope: Scope, o: { show?: Show } = {}) => run(() => after(dropOverlay(), () => goScopeInner(scope, o.show ?? "unread"))),
  setShow: (show: Show) =>
    run(() => {
      const s = getNavState();
      if (!s.loc.scope || !showApplies(s.loc.scope) || s.loc.show === show) return;
      const loc = locOf(s.loc.scope, show, s.loc.articleId);
      write("replace", loc, readFf() ?? { i: s.index, k: entryKindOf(loc, navLayout()) });
      setNavAnim("none");
      commit({ ...s, loc, cause: "replace" });
    }),
  setQuery: (q: string) => run(() => after(dropOverlay(), () => setQueryInner(q))),
  /** Any location as a fresh stack (cross-tab jump, consumed deep-link intents). */
  goTo: (loc: Loc) => run(() => after(dropOverlay(), () => resetStackInner(loc))),
  goTab: (tab: TabId) => run(() => after(dropOverlay(), () => resetStackInner(tabMemoryLoc(tab)))),
  /** Opens an overlay (palette, shortcuts, add-feed, sheet, search); swaps an open one — overlays never nest. */
  openOverlay: (id: OverlayId) => run(() => openOverlayInner(id)),
  /** Closes the open overlay (`only`: just when it is that one); history.back() when its entry was pushed. */
  closeOverlay: (only?: OverlayId) => run(() => (!only || getNavState().overlay === only ? closeOverlayInner() : undefined)),
  /** Toggle (⌘K): open, or close when this overlay is the open one. */
  toggleOverlay: (id: OverlayId) => run(() => (getNavState().overlay === id ? closeOverlayInner() : openOverlayInner(id))),
};

/**
 * Mount-time setup of the shell: manual scroll restoration, alias
 * normalization (replaceState), stack seeding for cold deep links (so system
 * back lands on the list / Feeds root instead of leaving the app) and the
 * single popstate listener. `onIntents` receives one-shot params (add-feed,
 * share target) after the URL has been cleaned.
 */
export function bootNav(onIntents: (intents: LocIntents) => void): () => void {
  if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
  window.addEventListener("popstate", onPopState);
  let unguard = () => {};
  let disposed = false;
  const settleBoot = () => {
    if (disposed) return;
    const { loc, intents, changed } = normalizeSearch(window.location.search);
    const ff = readFf();
    const layout = navLayout();
    let index = ff?.i ?? 0;
    stackLayout = layout;
    if (!ff) {
      const chain = stackOf(loc, layout);
      chain.forEach((l, j) => write(j === 0 ? "replace" : "push", l, { i: j, k: entryKindOf(l, layout) }));
      index = chain.length - 1;
    } else if (changed || ff.k === "overlay") {
      // An overlay entry at the bottom of the stack (not app-pushed; should not
      // happen): nothing to step back onto — turn it into a plain entry in place.
      write("replace", loc, ff.k === "overlay" ? { i: ff.i, k: entryKindOf(loc, layout) } : ff);
    }
    setNavAnim("none");
    commit({ loc, overlay: null, index, cause: "init" });
    if (intents.addFeed || intents.sharedUrl) onIntents(intents);
  };
  const cancel = whenRouterReady(() => {
    unguard = keepFfAcrossRouterWrites();
    const ff = readFf();
    if (ff?.k === "overlay" && ff.i > 0) {
      // Reloaded with an overlay open: the overlay is gone, its transient entry
      // would become a duplicate of the entry beneath (Back = same screen).
      // Step back onto that entry and boot from there; the stale entry stays
      // only as a forward entry, dropped by the next push.
      void run(() => goAndWait(-1).then(settleBoot));
    } else {
      settleBoot();
    }
  });
  const unwatchLayout = subscribeLayoutClass(scheduleReconcile);
  return () => {
    cancel();
    unguard();
    unwatchLayout();
    disposed = true;
    stackLayout = null;
    reconcileQueued = false;
    window.removeEventListener("popstate", onPopState);
    if (pending) window.clearTimeout(pending.timer);
    pending = null;
    queue = null;
    state = null; // a remount (back from /settings) re-reads the URL
  };
}

// ------------------------------------------------------------ React bindings
const ServerNav = createContext<NavState>(FALLBACK);

/** Provides the server snapshot (from the request URL) so SSR and hydration agree. */
export function NavProvider({ initialHref, children }: { initialHref: string; children: ReactNode }) {
  const value = useMemo<NavState>(() => ({ ...FALLBACK, loc: parseLoc(searchOf(initialHref)) }), [initialHref]);
  return createElement(ServerNav.Provider, { value }, children);
}

/** Subscribes to a slice of the nav state. The selector must return a primitive or a stored object. */
export function useNav<T>(selector: (s: NavState) => T): T {
  const server = useContext(ServerNav);
  return useSyncExternalStore(
    subscribeNav,
    () => selector(getNavState()),
    () => selector(server),
  );
}
