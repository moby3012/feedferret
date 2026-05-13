"use client";

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs } from "@/components/ui/tabs";
import {
  ResponsiveTabsNav,
  type ResponsiveTabOption,
} from "@/components/responsive-tabs-nav";
import { cn } from "@/lib/utils";

export function SettingsModalShell({
  open,
  onOpenChange,
  eyebrow = "FeedFerret",
  title,
  description,
  tabs,
  activeTab,
  onTabChange,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eyebrow?: string;
  title: string;
  description?: string;
  tabs: ResponsiveTabOption[];
  activeTab: string;
  onTabChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "h-[min(92dvh,900px)] w-[calc(100vw-1rem)] max-w-5xl grid-rows-[auto_1fr] gap-0 overflow-hidden rounded-[2rem] border border-border/70 bg-background p-0 shadow-2xl",
          className,
        )}
      >
        <DialogHeader className="border-b border-border/60 bg-card/95 p-5 pb-4 backdrop-blur-2xl sm:p-8 sm:pb-5">
          <div className="flex flex-col gap-1 pr-10">
            {eyebrow ? (
              <div className="text-sm font-medium text-muted-foreground">
                {eyebrow}
              </div>
            ) : null}
            <DialogTitle className="text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">
              {title}
            </DialogTitle>
            {description ? (
              <DialogDescription className="mt-1 text-sm text-muted-foreground sm:text-base">
                {description}
              </DialogDescription>
            ) : null}
          </div>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={onTabChange}
          className="h-full min-h-0 flex-1 gap-0 overflow-hidden"
        >
          <div className="border-b border-border/50 bg-background/80 px-5 py-3 sm:px-8">
            <ResponsiveTabsNav
              value={activeTab}
              onValueChange={onTabChange}
              options={tabs}
              triggerClassName="gap-2 px-4 lg:px-5"
            />
          </div>
          {children}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

export function SettingsSection({
  title,
  description,
  icon,
  children,
  className,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl",
        className,
      )}
    >
      <div className="mb-5 flex items-start gap-3">
        {icon ? (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-background text-primary shadow-sm">
            {icon}
          </div>
        ) : null}
        <div>
          <h3 className="text-lg font-semibold tracking-[-0.02em]">{title}</h3>
          {description ? (
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
}
