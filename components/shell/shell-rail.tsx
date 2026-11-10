"use client";

import { memo } from "react";
import { useTranslations } from "next-intl";
import { PanelLeftOpen, Settings } from "lucide-react";
import { useCountsQuery } from "@/features/bootstrap/queries";
import { getLayoutClass } from "@/features/reader/layout/layout-class";
import { nav, useNav } from "@/features/reader/nav/store";
import { useShellActions } from "./shell-context";
import { TABS, activateTab, onTablistKeyDown, paneIdsOf } from "./tabs";

/**
 * 72 px icon rail (spec §3.2): the navigation of the medium layout
 * (768–1199 px) and of the expanded layout with the sidebar collapsed (`[`).
 * The same four destinations as the compact tab bar, plus "show sources"
 * (medium: the feeds tree as a drawer; expanded: expand the sidebar) and
 * settings. Static markup — CSS decides where it shows, so first paint never
 * waits for JS.
 */
export const ShellRail = memo(function ShellRail() {
  const t = useTranslations("tabs");
  const shell = useShellActions();
  const active = useNav((s) => s.loc.tab);
  const hasUnread = (useCountsQuery(true).data?.unreadTotal ?? 0) > 0;
  const showSources = () => {
    if (getLayoutClass() === "expanded") shell.toggleSourcesCollapsed();
    else void nav.openOverlay("sources");
  };
  return (
    <nav className="ff-rail" aria-label={t("label")} data-testid="shell-rail">
      <button type="button" className="ff-rail-btn" onClick={showSources} aria-label={t("showSources")} title={t("showSources")}>
        <PanelLeftOpen className="size-5" strokeWidth={1.75} aria-hidden />
      </button>
      <div role="tablist" aria-orientation="vertical" className="flex flex-col items-center gap-1" onKeyDown={(e) => onTablistKeyDown(e, "vertical")}>
        {TABS.map(({ id, icon: Icon, label }) => {
          const selected = id === active;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`ff-rail-tab-${id}`}
              aria-selected={selected}
              aria-controls={paneIdsOf(id)}
              tabIndex={selected ? 0 : -1}
              data-active={selected ? "" : undefined}
              className="ff-rail-tab"
              onClick={() => void activateTab(id)}
            >
              <span className="relative">
                <Icon className="size-6" strokeWidth={1.75} aria-hidden />
                {id === "new" && hasUnread && <span className="ff-tab-dot" aria-hidden />}
              </span>
              <span className="text-caption">{t(label)}</span>
            </button>
          );
        })}
      </div>
      <button type="button" className="ff-rail-btn mt-auto" onClick={shell.openSettings} aria-label={t("settings")} title={t("settings")}>
        <Settings className="size-5" strokeWidth={1.75} aria-hidden />
      </button>
    </nav>
  );
});
