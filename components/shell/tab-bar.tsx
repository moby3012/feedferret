"use client";

import { memo } from "react";
import { useTranslations } from "next-intl";
import { useCountsQuery } from "@/features/bootstrap/queries";
import { useKeyboardOpen } from "@/features/reader/layout/keyboard-inset";
import { useNav } from "@/features/reader/nav/store";
import { cn } from "@/lib/utils";
import { TABS, activateTab, onTablistKeyDown, paneIdsOf } from "./tabs";

/**
 * Compact navigation (spec §4.6): the floating pill with the four tabs
 * Neu · Gemerkt · Feeds · Suche. Hidden on wide (CSS; the rail takes over)
 * and slid out while the reader, an overlay or the on-screen keyboard is up.
 * Never hides on list scroll. Unread is a dot on Neu — never a number.
 */
export const TabBar = memo(function TabBar() {
  const t = useTranslations("tabs");
  const active = useNav((s) => s.loc.tab);
  const readerOpen = useNav((s) => !!s.loc.articleId);
  const overlayOpen = useNav((s) => s.overlay !== null);
  const keyboardOpen = useKeyboardOpen();
  const hasUnread = (useCountsQuery(true).data?.unreadTotal ?? 0) > 0;
  const hidden = readerOpen || overlayOpen || keyboardOpen;
  return (
    <nav
      className="ff-tabbar"
      data-testid="tab-bar"
      data-hidden={hidden ? "" : undefined}
      aria-label={t("label")}
      inert={hidden || undefined}
      aria-hidden={hidden || undefined}
    >
      <div role="tablist" aria-orientation="horizontal" className="ff-tabbar-list" onKeyDown={(e) => onTablistKeyDown(e, "horizontal")}>
        {TABS.map(({ id, icon: Icon, label }) => {
          const selected = id === active;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`ff-tab-${id}`}
              aria-selected={selected}
              aria-controls={paneIdsOf(id)}
              tabIndex={selected ? 0 : -1}
              data-active={selected ? "" : undefined}
              className="ff-tab"
              onClick={() => void activateTab(id)}
            >
              <span className="relative">
                <Icon className="size-6" strokeWidth={1.75} aria-hidden />
                {id === "new" && hasUnread && <span className="ff-tab-dot" data-testid="tab-unread-dot" aria-hidden />}
              </span>
              <span className={cn("text-caption", selected ? "font-semibold" : "font-medium")}>{t(label)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
});
