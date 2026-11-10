"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Search as SearchIcon, X as XIcon } from "lucide-react";
import { clearSearch, commitSearch, committedQuery, useSearchDraft } from "@/components/shell/search-draft";
import { onSearchFocusRequest, takeSearchFocus } from "@/components/shell/tabs";
import { recordRecentQuery } from "./recent-queries";

/**
 * The one search UI (spec §4.6 Suche): a field in the Suche tab's top bar.
 * Typing commits `?q=` 300 ms after the last keystroke (replace); Enter
 * commits at once. Focus is taken only when asked for (tab tap into an empty
 * Suche tab, `/`, the palette, the sidebar search icon) — never on restore.
 */
export function SearchField({ active }: { active: boolean }) {
  const t = useTranslations("searchResults");
  const tSidebar = useTranslations("sidebar");
  const tA11y = useTranslations("accessibility");
  const [draft, setDraft] = useSearchDraft();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!active) return;
    const focus = () => {
      if (!takeSearchFocus()) return;
      // Next frame: the pane just became visible (visibility / inert flip).
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    };
    focus();
    return onSearchFocusRequest(focus);
  }, [active]);

  return (
    <form
      role="search"
      className="ff-search-field"
      onSubmit={(e) => {
        e.preventDefault();
        const q = draft.trim();
        if (!q) return;
        recordRecentQuery(q);
        void commitSearch(q);
        // Hide the on-screen keyboard: the results are what the user wants to see now.
        inputRef.current?.blur();
      }}
    >
      <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const q = committedQuery();
          if (q && q === draft.trim()) recordRecentQuery(q);
        }}
        placeholder={t("fieldPlaceholder")}
        aria-label={tSidebar("searchArticles")}
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        data-testid="search-field"
      />
      {draft && (
        <button
          type="button"
          className="hit-slop absolute end-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-control text-muted-foreground"
          onClick={() => {
            void clearSearch();
            inputRef.current?.focus({ preventScroll: true });
          }}
          aria-label={tA11y("clearSearch")}
        >
          <XIcon className="size-4" aria-hidden />
        </button>
      )}
    </form>
  );
}
