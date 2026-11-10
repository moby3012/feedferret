"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getNavState, nav, subscribeNav, useNav } from "@/features/reader/nav/store";

// Search draft text (spec §1.3 — not in the URL while typing).
// The field in the Suche tab's top bar edits this module's draft; it is
// committed to `?q=` (replace) 300 ms after the last keystroke, or at once on
// Enter. Any history traversal (system / UI back) or tab switch cancels a
// pending commit and resets the draft to what the landed entry has committed.

export const SEARCH_COMMIT_DELAY_MS = 300;

/** Debounced commit of the inline draft; `cancel` drops a pending commit. Pure (unit-tested). */
export function createDraftCommitter(opts: {
  commit: (text: string) => void;
  committed: () => string;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}) {
  const setTimer = opts.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => window.clearTimeout(h as number));
  let handle: unknown = null;
  let value = "";
  const cancel = () => {
    if (handle !== null) clearTimer(handle);
    handle = null;
  };
  return {
    /** The inline draft changed. */
    edit(text: string) {
      value = text;
      cancel();
      handle = setTimer(() => {
        handle = null;
        const trimmed = value.trim();
        if (trimmed !== opts.committed()) opts.commit(trimmed);
      }, opts.delayMs ?? SEARCH_COMMIT_DELAY_MS);
    },
    cancel,
    get pending() {
      return handle !== null;
    },
  };
}

let draft = "";
const listeners = new Set<() => void>();

export const searchDraft = {
  get: () => draft,
  set(value: string) {
    if (value === draft) return;
    draft = value;
    listeners.forEach((l) => l());
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useSearchDraft(): [string, (value: string) => void] {
  const value = useSyncExternalStore(searchDraft.subscribe, searchDraft.get, () => "");
  return [value, searchDraft.set];
}

export const committedQuery = () => {
  const scope = getNavState().loc.scope;
  return scope?.kind === "query" ? scope.q : "";
};

/** Shell-level: keeps the inline draft in sync with `?q=` and commits debounced edits. */
export function useSearchCommit() {
  const q = useNav((s) => (s.loc.scope?.kind === "query" ? s.loc.scope.q : ""));
  useEffect(() => {
    // URL changed (back, clear, saved search, dialog submit…): the draft follows.
    if (q !== searchDraft.get().trim()) searchDraft.set(q);
  }, [q]);

  useEffect(() => {
    const committer = createDraftCommitter({ commit: (text) => void nav.setQuery(text), committed: committedQuery });
    let syncing = false;
    const unsubscribeDraft = searchDraft.subscribe(() => {
      if (!syncing) committer.edit(searchDraft.get());
    });
    const unsubscribeNav = subscribeNav(() => {
      const cause = getNavState().cause;
      if ((cause !== "pop-os" && cause !== "pop-ui" && cause !== "tab") || !committer.pending) return;
      // Back (or a tab switch) while an edit was pending: it is dismissed, not committed.
      committer.cancel();
      syncing = true;
      searchDraft.set(committedQuery());
      syncing = false;
    });
    return () => {
      unsubscribeDraft();
      unsubscribeNav();
      committer.cancel();
    };
  }, []);
}

/** Commit right away (Enter, a recent / saved query). */
export function commitSearch(text = searchDraft.get()) {
  return nav.setQuery(text);
}

export function clearSearch() {
  searchDraft.set("");
  return nav.setQuery("");
}
