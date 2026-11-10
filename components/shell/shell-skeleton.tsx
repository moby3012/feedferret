import type { CSSProperties } from "react";
import { ArticleListSkeleton, type SkeletonViewMode } from "@/components/list/article-skeleton";
import type { UiPrefs } from "@/features/reader/layout/ui-prefs";
import { parseLoc } from "@/features/reader/nav/location";

/**
 * Server-rendered app shell while the cold-start data streams in (spec §2.5.3;
 * the `<Suspense>` fallback of app/page.tsx). Same root, panes and data
 * attributes as the real shell, so app/styles/shell.css places everything
 * exactly where the shell will be: the top bar, skeleton rows of the user's
 * view mode, the rail (medium / collapsed sidebar) and the compact tab bar —
 * never a spinner. Nothing in here is
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
      data-sources={ui.sidebarCollapsed ? "rail" : "full"}
      data-shell-skeleton=""
      aria-busy="true"
      style={style}
    >
      <div data-pane="sources" className="overflow-hidden">
        <div className="ff-rail" />
      </div>
      <section data-pane={`list-${loc.tab}`} data-active="true" className="relative flex flex-col border-e border-border/60 bg-card/70">
        <div className="ff-list-bar">
          <div className="ff-list-bar-row">
            <div className="h-5 w-36 rounded-chip bg-muted animate-pulse" />
          </div>
        </div>
        {loc.scope && <ArticleListSkeleton viewMode={mode} count={8} />}
      </section>
      <section data-pane="reader" className="flex bg-background" />
      <div className="ff-tabbar" data-hidden={loc.articleId ? "" : undefined} aria-hidden />
    </div>
  );
}
