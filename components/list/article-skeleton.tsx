import { cn } from "@/lib/utils";

// Placeholder rows of the article list. No "use client": the server-rendered
// cold-start skeleton (components/shell/shell-skeleton.tsx) and the client
// list (loading state) draw the very same boxes, so nothing jumps between them.

export type SkeletonViewMode = "list" | "grid" | "magazine" | "minimal";

export function ArticleSkeleton({ viewMode = "list" }: { viewMode?: SkeletonViewMode }) {
  if (viewMode === "magazine") {
    return (
      <div className="rounded-xl border border-border/50 bg-card overflow-hidden animate-pulse">
        <div className="h-36 bg-muted" />
        <div className="p-3 space-y-2">
          <div className="h-3 bg-muted rounded w-1/3" />
          <div className="h-4 bg-muted rounded w-full" />
          <div className="h-4 bg-muted rounded w-3/4" />
        </div>
      </div>
    );
  }
  if (viewMode === "minimal") {
    return (
      <div className="rounded-xl flex items-center gap-2 px-1 py-1.5 animate-pulse">
        <div className="size-3.5 rounded-full bg-muted shrink-0" />
        <div className="h-3.5 bg-muted rounded flex-1" />
        <div className="h-3 bg-muted rounded w-12 shrink-0" />
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border/50 bg-card p-3 space-y-2.5 animate-pulse">
      <div className="flex items-center gap-2">
        <div className="size-4 rounded-sm bg-muted shrink-0" />
        <div className="h-3 bg-muted rounded w-24" />
        <div className="h-3 bg-muted rounded w-16 ml-auto" />
      </div>
      <div className="space-y-1.5">
        <div className="h-4 bg-muted rounded w-full" />
        <div className="h-4 bg-muted rounded w-5/6" />
      </div>
      <div className="h-3 bg-muted rounded w-3/4" />
    </div>
  );
}

/** The list's loading state: as many rows as fill a phone screen in each view mode. */
export function ArticleListSkeleton({ viewMode = "list", count }: { viewMode?: SkeletonViewMode; count?: number }) {
  const skeletonCount = count ?? (viewMode === "magazine" ? 4 : viewMode === "minimal" ? 8 : 6);
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex-1 overflow-hidden p-3 pb-28 wide:pb-3 space-y-2.5",
        viewMode === "magazine" && "grid grid-cols-1 gap-4 space-y-0",
      )}
    >
      {Array.from({ length: skeletonCount }).map((_, i) => (
        <ArticleSkeleton key={i} viewMode={viewMode} />
      ))}
    </div>
  );
}
