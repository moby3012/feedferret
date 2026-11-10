"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { Minus, Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  READER_FONTS,
  READER_LEADINGS,
  READER_SIZE_MAX,
  READER_SIZE_MIN,
  READER_THEMES,
  READER_WIDTHS,
  clampSize,
  resetReaderTypography,
  setReaderTypography,
  type ResolvedTypography,
} from "@/features/reader/typography/typography";
import { useOwnedOverlay } from "@/features/reader/nav/use-owned-overlay";
import { cn } from "@/lib/utils";
import { ChromeButton } from "./chrome-button";
import "@/app/styles/reader-aa.css";

const FONT_KEY = { sans: "fontSans", serif: "fontSerif", rounded: "fontRounded" } as const;
const WIDTH_KEY = { narrow: "widthNarrow", medium: "widthMedium", wide: "widthWide", full: "widthFull" } as const;
const LEADING_KEY = { 1.45: "leadingTight", 1.6: "leadingNormal", 1.8: "leadingLoose" } as const;
const THEME_KEY = { auto: "themeAuto", light: "themeLight", dark: "themeDark", sepia: "themeSepia" } as const;

/**
 * "Aa" sheet (lazy chunk; its trigger placeholder looks the same). Non-modal
 * popover: every change is written to the typography store at once and the
 * reader behind it re-styles live (CSS variables only), and the sample in the
 * sheet uses the same variables.
 */
type SheetProps = { resolved: ResolvedTypography; effectiveSize: () => number };

export default function ReaderTypographySheetEntry(p: SheetProps | { warmup: true }) {
  return "warmup" in p ? null : <ReaderTypographySheet {...p} />;
}

function ReaderTypographySheet({ resolved, effectiveSize }: SheetProps) {
  const t = useTranslations("articleReader");
  // A nav overlay: system Back closes the sheet, not the reader beneath.
  const [open, setOpen] = useOwnedOverlay("reader-aa");
  const size = resolved.size ?? effectiveSize();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ChromeButton aria-label={t("typography")} title={t("typography")} className="ff-aa-btn">
          <span aria-hidden="true">Aa</span>
        </ChromeButton>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} collisionPadding={12} className="ff-aa-sheet"
        aria-label={t("typography")}
        // Esc closes the sheet only — not also the reader (the shell's global Esc).
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        <p
          className={cn("ff-aa-preview", resolved.theme === "dark" && "dark")}
          data-reader-font={resolved.font}
          data-reader-theme={resolved.theme === "auto" ? undefined : resolved.theme}
          style={{ fontSize: `${size}px`, lineHeight: resolved.leading ?? 1.6 }}
          data-testid="typography-preview"
        >
          {t("typographyPreview")}
        </p>
        <Segmented
          label={t("fontStyle")}
          options={READER_FONTS.map((f) => ({ value: f, label: t(FONT_KEY[f]), font: f }))}
          value={resolved.font}
          onChange={(font) => setReaderTypography({ font })}
        />
        <div className="ff-aa-row ff-aa-row-inline">
          <span className="ff-aa-label" id="aa-size-label">
            {t("textSize")}
          </span>
          <div className="flex items-center gap-1" role="group" aria-labelledby="aa-size-label">
            <ChromeButton aria-label={t("smaller")} disabled={size <= READER_SIZE_MIN} onClick={() => setReaderTypography({ size: clampSize(size - 1) })}>
              <Minus className="size-4" />
            </ChromeButton>
            <output className="w-12 text-center text-body-sm tabular-nums" aria-live="polite" data-testid="typography-size">
              {size}px
            </output>
            <ChromeButton aria-label={t("larger")} disabled={size >= READER_SIZE_MAX} onClick={() => setReaderTypography({ size: clampSize(size + 1) })}>
              <Plus className="size-4" />
            </ChromeButton>
          </div>
        </div>
        <Segmented
          label={t("lineSpacing")}
          options={READER_LEADINGS.map((l) => ({ value: String(l), label: t(LEADING_KEY[l]) }))}
          value={String(resolved.leading ?? 1.6)}
          onChange={(v) => setReaderTypography({ leading: Number(v) })}
        />
        <Segmented
          label={t("lineWidth")}
          options={READER_WIDTHS.map((w) => ({ value: w, label: t(WIDTH_KEY[w]) }))}
          value={resolved.width}
          onChange={(width) => setReaderTypography({ width })}
        />
        <Segmented
          label={t("readerTheme")}
          options={READER_THEMES.map((th) => ({ value: th, label: t(THEME_KEY[th]), swatch: th }))}
          value={resolved.theme}
          onChange={(theme) => setReaderTypography({ theme: theme === "auto" ? undefined : theme })}
        />
        <button type="button" className="ff-aa-reset" onClick={resetReaderTypography}>
          {t("resetTypography")}
        </button>
      </PopoverContent>
    </Popover>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; font?: string; swatch?: string }[];
  value: string;
  onChange: (v: T) => void;
}) {
  const id = useId();
  // Roving tab stop: the checked option; with none checked (a value the
  // options do not represent), the first one — the group stays reachable.
  const checked = options.findIndex((o) => o.value === value);
  const tabStop = checked >= 0 ? checked : 0;
  return (
    <div className="ff-aa-row">
      <span className="ff-aa-label" id={id}>
        {label}
      </span>
      <div className="ff-aa-segmented" role="radiogroup" aria-labelledby={id}>
        {options.map((o, index) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            data-reader-font={o.font}
            data-swatch={o.swatch}
            className={cn("ff-aa-seg", o.value === value && "is-on")}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const i = checked >= 0 ? checked : index;
              const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!dir) return;
              e.preventDefault();
              const rtl = getComputedStyle(e.currentTarget).direction === "rtl" && (e.key === "ArrowRight" || e.key === "ArrowLeft");
              const next = options[(i + (rtl ? -dir : dir) + options.length) % options.length];
              onChange(next.value);
              (e.currentTarget.parentElement?.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus();
            }}
            data-value={o.value}
            tabIndex={index === tabStop ? 0 : -1}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
