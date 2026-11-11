"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one segmented control (UX wave 2b, audit X11). A WAI-ARIA radio group:
 * one tab stop (the checked option), arrow keys move + select, RTL aware.
 * Styles: app/styles/controls.css (.ff-seg / .ff-seg-item).
 *
 * size "sm" = 32 px (top bars; hit-slop gives 44 on touch),
 * size "md" = 36 px fine / 44 px coarse (sheets, settings).
 */
export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when `label` is visual only (icon) or abbreviated. */
  ariaLabel?: string;
  /** Extra data attributes for the option (e.g. reader font / swatch hooks). */
  data?: Record<`data-${string}`, string | undefined>;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  labelledBy,
  size = "md",
  block = false,
  className,
  itemClassName,
  testId,
}: {
  options: SegmentedOption<T>[];
  value: string | undefined;
  onChange: (value: T) => void;
  /** Accessible name of the group (use this or `labelledBy`). */
  label?: string;
  labelledBy?: string;
  size?: "sm" | "md";
  /** Fill the container width (equal columns). */
  block?: boolean;
  className?: string;
  itemClassName?: string;
  testId?: string;
}) {
  // Roving tab stop: the checked option; with none checked (a value the
  // options do not represent), the first one — the group stays reachable.
  const checked = options.findIndex((o) => o.value === value);
  const tabStop = checked >= 0 ? checked : 0;
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={cn("ff-seg", className)}
      data-size={size}
      data-block={block ? "" : undefined}
      data-testid={testId}
    >
      {options.map((o, index) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            data-checked={on ? "" : undefined}
            data-value={o.value}
            {...o.data}
            tabIndex={index === tabStop ? 0 : -1}
            className={cn("ff-seg-item", size === "sm" && "hit-slop", itemClassName)}
            onClick={() => {
              if (!on) onChange(o.value);
            }}
            onKeyDown={(e) => {
              const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
              const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
              if (!fwd && !back) return;
              e.preventDefault();
              const horizontal = e.key === "ArrowRight" || e.key === "ArrowLeft";
              const rtl = horizontal && getComputedStyle(e.currentTarget).direction === "rtl";
              const dir = (fwd ? 1 : -1) * (rtl ? -1 : 1);
              const from = checked >= 0 ? checked : index;
              const next = options[(from + dir + options.length) % options.length];
              onChange(next.value);
              e.currentTarget.parentElement
                ?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)
                ?.focus();
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
