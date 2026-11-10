"use client";

import { WifiOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useOnline } from "@/features/bootstrap/online";

/**
 * Shown in the top bar while the device is offline. Owner decision: offline is
 * read-only — toggles are refused (with a toast), nothing is queued.
 */
export function OfflineChip({ className = "" }: { className?: string }) {
  const online = useOnline();
  const t = useTranslations("articleState");
  if (online) return null;
  return (
    <div
      role="status"
      data-testid="offline-chip"
      className={`inline-flex items-center gap-1.5 self-center rounded-full bg-warning/10 px-3 py-1 text-footnote font-medium text-warning ${className}`}
    >
      <WifiOff className="size-3.5" aria-hidden />
      {t("offlineReadOnly")}
    </div>
  );
}
