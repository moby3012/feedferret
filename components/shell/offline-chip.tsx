"use client";

import { WifiOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useOnline } from "@/features/bootstrap/online";

/**
 * Shown in the top bar while the device is offline. Owner decision: offline is
 * read-only — toggles are refused (with a toast), nothing is queued.
 *
 * Compact by design (audit R2): icon + "Offline" only, so the bar title and
 * "…" never get squeezed out; below ~360 px just the icon. The full sentence
 * is the accessible name and tooltip, and a tap shows it as a toast.
 */
export function OfflineChip({ className = "" }: { className?: string }) {
  const online = useOnline();
  const t = useTranslations("articleState");
  if (online) return null;
  const detail = t("offlineReadOnly");
  return (
    <span role="status" className="contents">
      <button
        type="button"
        data-testid="offline-chip"
        aria-label={detail}
        title={detail}
        onClick={() => toast.info(detail, { id: "offline-detail" })}
        className={`ff-offline-chip hit-slop inline-flex h-7 shrink-0 items-center gap-1 self-center rounded-chip bg-warning-subtle px-2 text-footnote font-medium text-warning ${className}`}
      >
        <WifiOff className="size-3.5 shrink-0" aria-hidden />
        <span className="ff-offline-chip-label">{t("offline")}</span>
      </button>
    </span>
  );
}
