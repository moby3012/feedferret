import { cn } from "@/lib/utils";
import type { Density } from "./article-row";

/** Placeholder row with the same paddings and heights as a real row of `density` (CLS 0). */
export function RowSkeleton({ density, nested = false }: { density: Density; nested?: boolean }) {
  if (density === "magazine") {
    return (
      <div className="ff-row animate-pulse" data-density="magazine" aria-hidden>
        <div className="ff-row-content">
          <div className="aspect-video w-full bg-surface-sunken" />
          <div className="space-y-2 p-3.5">
            <div className="h-3 w-1/3 rounded-chip bg-muted" />
            <div className="h-4 w-full rounded-chip bg-muted" />
            <div className="h-4 w-3/4 rounded-chip bg-muted" />
          </div>
        </div>
      </div>
    );
  }
  if (density === "minimal") {
    return (
      <div className="ff-row animate-pulse" data-density="minimal" data-nested={nested ? "" : undefined} aria-hidden>
        <div className="ff-row-content flex min-h-11 items-center gap-2 px-(--gutter) fine:min-h-9">
          <div className="size-3.5 shrink-0 rounded-xs bg-muted" />
          <div className="h-3.5 flex-1 rounded-chip bg-muted" />
          <div className="h-3 w-12 shrink-0 rounded-chip bg-muted" />
        </div>
      </div>
    );
  }
  return (
    <div className="ff-row animate-pulse" data-density="list" data-nested={nested ? "" : undefined} aria-hidden>
      <div className={cn("ff-row-content flex gap-3 px-(--gutter) py-(--row-pad-y)")}>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <div className="size-3.5 shrink-0 rounded-xs bg-muted" />
            <div className="h-3 w-24 rounded-chip bg-muted" />
          </div>
          <div className="h-4 w-full rounded-chip bg-muted" />
          <div className="h-4 w-5/6 rounded-chip bg-muted" />
          <div className="h-3 w-3/4 rounded-chip bg-muted" />
          <div className="h-8" />
        </div>
        <div className="ff-media-thumb mt-5 shrink-0 rounded-control bg-surface-sunken" />
      </div>
    </div>
  );
}
