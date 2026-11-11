"use client";

import type { ReactNode } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type ResponsiveTabOption = {
  value: string;
  label: string;
  icon?: ReactNode;
};

/**
 * Tab navigation for the settings-style pages and dialogs: the shared
 * segmented look (app/styles/controls.css). Tabs wrap onto further rows when
 * they do not fit (never clipped or hidden behind a scroll; audit A-09 / UX wave 2b).
 */
export function ResponsiveTabsNav({
  options,
  className,
  triggerClassName,
}: {
  value?: string;
  onValueChange?: (value: string) => void;
  options: ResponsiveTabOption[];
  className?: string;
  triggerClassName?: string;
}) {
  return (
    <div className={cn("w-full min-w-0", className)}>
      <TabsList data-wrap="" className="max-w-full">
        {options.map((option) => (
          <TabsTrigger key={option.value} value={option.value} className={triggerClassName}>
            {option.icon}
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );
}
