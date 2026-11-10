"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getNavState, nav, useNav } from "@/features/reader/nav/store";

// Search draft text: local until committed (spec §1.3 — not in the URL while
// typing). Committed to `?q=` (replace) 300 ms after the last keystroke,
// except while the search dialog is open: there it commits on submit.

const COMMIT_DELAY_MS = 300;
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

const committedQuery = () => {
  const scope = getNavState().loc.scope;
  return scope?.kind === "query" ? scope.q : "";
};

/** Shell-level: keeps the draft in sync with `?q=` and commits debounced edits. */
export function useSearchCommit() {
  const q = useNav((s) => (s.loc.scope?.kind === "query" ? s.loc.scope.q : ""));
  useEffect(() => {
    // URL changed (back, clear, saved search…): the draft follows.
    if (q !== searchDraft.get().trim()) searchDraft.set(q);
  }, [q]);

  useEffect(() => {
    let timer = 0;
    const unsubscribe = searchDraft.subscribe(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (getNavState().overlay === "search") return;
        const text = searchDraft.get().trim();
        if (text !== committedQuery()) void nav.setQuery(text);
      }, COMMIT_DELAY_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, []);
}

/** Commit right away (dialog submit / Enter): closes the dialog entry first. */
export function commitSearch(text = searchDraft.get()) {
  return nav.setQuery(text);
}

export function clearSearch() {
  searchDraft.set("");
  return nav.setQuery("");
}
