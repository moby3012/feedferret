"use client";

import { cn } from "@/lib/utils";

export interface ReaderNavProps {
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

export interface ReaderToggleProps {
  onToggleStar: () => void;
  onToggleRead: () => void;
  onToggleLater: () => void;
  onShare: () => void;
  onOpenOriginal: () => void;
}

/** 44 px icon button of the reader chrome (bar, pill, sheet; 36 px on fine pointers). */
export function ChromeButton({ className, pressed, ...props }: React.ComponentProps<"button"> & { pressed?: boolean }) {
  return <button type="button" aria-pressed={pressed} className={cn("ff-chrome-btn hit-slop", className)} {...props} />;
}
