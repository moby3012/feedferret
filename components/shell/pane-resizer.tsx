"use client";

import { useRef, type PointerEvent } from "react";
import { useTranslations } from "next-intl";
import { LIST_W_MAX, LIST_W_MIN, clampListW, writeUiPrefs } from "@/features/reader/layout/ui-prefs";

/**
 * 6 px handle between the list and reader columns (expanded only, CSS).
 * Writes `--list-w` on `.ff-shell` while dragging (no React state) and the
 * final width to the `ff_ui` cookie so the next SSR paints it right away.
 */
export function PaneResizer({ initialWidth = 380 }: { initialWidth?: number }) {
  const t = useTranslations("accessibility");
  const drag = useRef<{ startX: number; startW: number; shell: HTMLElement; dir: 1 | -1 } | null>(null);

  const widthOf = (shell: HTMLElement) => parseFloat(getComputedStyle(shell).getPropertyValue("--list-w")) || 380;
  const apply = (shell: HTMLElement, px: number) => {
    const w = clampListW(px);
    shell.style.setProperty("--list-w", `${w}px`);
    shell.querySelector(".ff-pane-resizer")?.setAttribute("aria-valuenow", String(w));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const shell = e.currentTarget.closest<HTMLElement>(".ff-shell");
    if (!shell) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const dir = getComputedStyle(shell).direction === "rtl" ? -1 : 1;
    drag.current = { startX: e.clientX, startW: widthOf(shell), shell, dir };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) apply(d.shell, d.startW + (e.clientX - d.startX) * d.dir);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d) writeUiPrefs({ listW: clampListW(widthOf(d.shell)) });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const shell = e.currentTarget.closest<HTMLElement>(".ff-shell");
    if (!shell) return;
    e.preventDefault();
    const next = clampListW(widthOf(shell) + (e.key === "ArrowRight" ? 16 : -16));
    apply(shell, next);
    writeUiPrefs({ listW: next });
  };

  return (
    <div
      className="ff-pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t("articleList")}
      aria-valuemin={LIST_W_MIN}
      aria-valuemax={LIST_W_MAX}
      aria-valuenow={initialWidth}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
