import type { CSSProperties } from "react";
import { ArticleListSkeleton, type SkeletonViewMode } from "@/components/list/article-skeleton";
import type { UiPrefs } from "@/features/reader/layout/ui-prefs";
import { parseLoc } from "@/features/reader/nav/location";

/**
 * Server-rendered app shell while the cold-start data streams in (spec §2.5.3;
 * the `<Suspense>` fallback of app/page.tsx). Same root, panes and data
 * attributes as the real shell, so app/styles/shell.css places everything
 * exactly where the shell will be: the top bar, skeleton rows of the user's
 * view mode and the compact bottom bar — never a spinner. Nothing in here is
 * interactive and nothing matches the harness's article-row selector.
 */
export function ShellSkeleton({ href, ui, viewMode }: { href: string; ui: UiPrefs; viewMode: string }) {
  const loc = parseLoc(href.includes("?") ? href.slice(href.indexOf("?")) : "");
  const mode: SkeletonViewMode = viewMode === "magazine" || viewMode === "grid" ? "magazine" : viewMode === "minimal" ? "minimal" : "list";
  const style = ui.listW ? ({ "--list-w": `${ui.listW}px` } as CSSProperties) : undefined;
  return (
    <div
      className="ff-shell app-chrome"
      data-tab={loc.tab}
      data-scope={loc.scope ? "1" : "0"}
      data-reader={loc.articleId ? "open" : "closed"}
      data-shell-skeleton=""
      aria-busy="true"
      style={style}
    >
      <div data-pane="sources" className="overflow-hidden" />
      <section data-pane={`list-${loc.tab}`} data-active="true" className="relative flex flex-col border-e border-border/60 bg-card/70">
        <div className="min-h-16 flex items-center gap-3 px-4 sm:px-5 pt-(--safe-t) border-b border-border/60 bg-card/75 relative z-(--z-bar)">
          <div className="h-5 w-36 rounded bg-muted animate-pulse" />
        </div>
        {loc.scope && <ArticleListSkeleton viewMode={mode} count={8} />}
      </section>
      <section data-pane="reader" className="flex bg-background" />
      {loc.scope && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-(--z-bar) bg-background/95 pl-[max(1rem,var(--safe-l))] pr-[max(1rem,var(--safe-r))] pb-[max(0.75rem,var(--safe-b))] wide:hidden">
          <div className="h-16 rounded-sheet border border-border/70 bg-background/90 shadow-overlay" />
        </div>
      )}
    </div>
  );
}
