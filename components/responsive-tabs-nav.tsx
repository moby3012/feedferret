"use client";

import type { ReactNode } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type ResponsiveTabOption = {
  value: string;
  label: string;
  icon?: ReactNode;
};

export function ResponsiveTabsNav({
  value,
  onValueChange,
  options,
  className,
  triggerClassName,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: ResponsiveTabOption[];
  className?: string;
  triggerClassName?: string;
}) {
  return (
    <div className={cn("w-full", className)}>
      <div className="sm:hidden">
        <Select value={value} onValueChange={onValueChange}>
          <SelectTrigger className="h-11 w-full rounded-2xl border-border/70 bg-background/80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-2xl">
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <TabsList className="hidden h-auto max-w-full flex-wrap justify-start gap-1 bg-muted/45 p-1 rounded-2xl border border-border/60 shadow-inner shadow-black/[0.02] sm:inline-flex">
        {options.map((option) => (
          <TabsTrigger
            key={option.value}
            value={option.value}
            className={cn(
              "rounded-xl px-4 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm",
              triggerClassName,
            )}
          >
            {option.icon}
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );
}
