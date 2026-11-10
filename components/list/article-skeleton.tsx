import type { Density } from "./article-row";
import { RowSkeleton } from "./row-skeleton";

// Placeholder rows of the article list. No "use client": the server-rendered
// cold-start skeleton (components/shell/shell-skeleton.tsx) and the client
// list (loading state, components/list/article-list-view.tsx) draw the very
// same row v2 boxes (RowSkeleton), so nothing jumps between them.

export type SkeletonViewMode = "list" | "grid" | "magazine" | "minimal";

export function skeletonDensity(viewMode: SkeletonViewMode): Density {
  return viewMode === "minimal" ? "minimal" : viewMode === "magazine" || viewMode === "grid" ? "magazine" : "list";
}

/** The list's loading state: as many rows as fill a phone screen in each view mode. */
export function ArticleListSkeleton({ viewMode = "list", count }: { viewMode?: SkeletonViewMode; count?: number }) {
  const density = skeletonDensity(viewMode);
  const skeletonCount = count ?? (density === "magazine" ? 4 : density === "minimal" ? 12 : 6);
  return (
    <div className="flex-1 overflow-hidden" data-testid="list-skeleton" aria-hidden="true">
      <div className="ff-list" data-density={density}>
        {Array.from({ length: skeletonCount }).map((_, i) => (
          <RowSkeleton key={i} density={density} />
        ))}
      </div>
    </div>
  );
}
