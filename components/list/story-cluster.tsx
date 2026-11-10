"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { toLegacyArticle, type LegacyContext } from "@/features/articles/legacy-adapter";
import { useClusterMembers } from "@/features/articles/queries";
import { ArticleRow, type Density, type RowHandlers, type RowSwipeMap } from "./article-row";
import { RowSkeleton } from "./row-skeleton";
import type { StoryGroup } from "./group-stories";

export { groupStories, type DisplayRow, type StoryGroup } from "./group-stories";

// Story cluster card, expanded part (#226): every other visible source of the
// story as a nested member row. Loaded on first expand from
// GET /api/app/clusters/:id and cached as a one-page list, so toggles on
// member rows are ordinary optimistic patches.

export function ClusterMembers({
  story,
  density,
  handlers,
  swipeMap,
  legacyContext,
  selectedId,
}: {
  story: StoryGroup;
  density: Density;
  handlers: RowHandlers;
  swipeMap: RowSwipeMap;
  legacyContext: LegacyContext;
  selectedId: string | null;
}) {
  const t = useTranslations("articleList");
  const members = useClusterMembers(story.clusterId);
  const rows = useMemo(
    () => members.items.filter((m) => m.id !== story.rep.id).map((m) => toLegacyArticle(m, legacyContext)),
    [members.items, story.rep.id, legacyContext],
  );
  return (
    <div className="ff-cluster-members" role="group" aria-label={t("storySources")} data-testid="cluster-members" data-cluster-id={story.clusterId}>
      {members.status === "pending" &&
        // Reserve the expected height: one skeleton per known source (max 3).
        Array.from({ length: Math.min(3, Math.max(1, story.more)) }).map((_, i) => <RowSkeleton key={i} density={density === "magazine" ? "list" : density} nested />)}
      {members.status === "error" && (
        <div className="flex items-center gap-3 px-(--gutter) py-3 text-body-sm text-muted-foreground">
          <span>{t("sourcesFailed")}</span>
          <button type="button" onClick={members.retry} className="hit-slop inline-flex h-8 items-center gap-1.5 rounded-control px-2 font-medium text-foreground hover:bg-surface-sunken">
            <RefreshCw className="size-3.5" aria-hidden />
            {t("retry")}
          </button>
        </div>
      )}
      {rows.map((article) => (
        <ArticleRow
          key={article.id}
          article={article}
          density={density === "magazine" ? "list" : density}
          selected={selectedId === article.id}
          handlers={handlers}
          swipeMap={swipeMap}
          cluster={null}
          nested
        />
      ))}
    </div>
  );
}
