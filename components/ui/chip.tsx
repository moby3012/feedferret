import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * The one chip (UX wave 2b, audit X11). Styles: app/styles/controls.css.
 *
 * size  md = 32 px bar chip (filter, label, offline) · sm = 28 px in-content
 *       chip (label row, cluster) · xs = 16 px row meta badge (fits the footnote source line) (sponsored,
 *       duplicate, labels; not interactive).
 * tone  neutral (hairline) · muted (filled) · warning.
 * Pressed (`aria-pressed` / `aria-expanded`) = --accent-subtle.
 * Interactive chips get `.hit-slop` (44 px on touch) automatically.
 */
type ChipStyle = { size?: "xs" | "sm" | "md"; tone?: "neutral" | "muted" | "warning" };

export function Chip({ size = "md", tone = "neutral", className, type = "button", ...props }: ComponentProps<"button"> & ChipStyle) {
  return (
    <button
      type={type}
      data-size={size}
      data-tone={tone}
      className={cn("ff-chip hit-slop focus-ring", className)}
      {...props}
    />
  );
}

/** Non-interactive chip (meta badge). */
export function ChipLabel({ size = "xs", tone = "muted", className, ...props }: ComponentProps<"span"> & ChipStyle) {
  return <span data-size={size} data-tone={tone} className={cn("ff-chip", className)} {...props} />;
}
