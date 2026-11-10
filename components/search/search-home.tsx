"use client";

import { useTranslations } from "next-intl";
import { Clock, Search as SearchIcon } from "lucide-react";
import { useShellData } from "@/components/shell/shell-context";
import { commitSearch } from "@/components/shell/search-draft";
import { clearRecentQueries, recordRecentQuery, useRecentQueries } from "./recent-queries";

/** Suche root (no query): saved searches + the last 8 queries (spec §4.6). */
export function SearchHome() {
  const t = useTranslations("searchHome");
  const tSearch = useTranslations("searchResults");
  const { savedSearches } = useShellData();
  const recent = useRecentQueries();
  const run = (q: string) => {
    recordRecentQuery(q);
    void commitSearch(q);
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-(--content-pad-bottom)" data-testid="search-home">
      {savedSearches.length > 0 && (
        <section aria-labelledby="ff-saved-searches" className="pt-2">
          <h3 id="ff-saved-searches" className="px-(--gutter) pb-1 text-footnote font-semibold text-muted-foreground">
            {t("savedSearches")}
          </h3>
          <ul>
            {savedSearches.map((s: { id: string; name: string; query: string }) => (
              <li key={s.id}>
                <button type="button" className="ff-search-item" onClick={() => run(s.query)}>
                  <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  {s.name !== s.query && <span className="max-w-[40%] truncate text-footnote text-muted-foreground">{s.query}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {recent.length > 0 && (
        <section aria-labelledby="ff-recent-searches" className="pt-2">
          <div className="flex items-center justify-between px-(--gutter) pb-1">
            <h3 id="ff-recent-searches" className="text-footnote font-semibold text-muted-foreground">
              {t("recent")}
            </h3>
            <button type="button" className="hit-slop text-footnote font-medium text-primary" onClick={clearRecentQueries}>
              {t("clearRecent")}
            </button>
          </div>
          <ul>
            {recent.map((q) => (
              <li key={q}>
                <button type="button" className="ff-search-item" onClick={() => run(q)}>
                  <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{q}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="px-(--gutter) py-6 text-center text-footnote text-muted-foreground">{tSearch("globalSearchHint")}</p>
    </div>
  );
}

/** No result for the committed query. */
export function SearchEmpty() {
  const t = useTranslations("searchResults");
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <SearchIcon className="mb-3 size-7 text-muted-foreground" aria-hidden />
      <h3 className="text-body font-semibold text-foreground">{t("emptyTitle")}</h3>
      <p className="mt-1 max-w-sm text-body-sm text-muted-foreground">{t("emptyDescription")}</p>
    </div>
  );
}
