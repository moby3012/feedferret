"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { formatBytes, readStorageEstimate, type StorageEstimate } from "@/features/offline/storage";
import { clearOfflineArticles, getActiveUser, getUsage, readStatus, type OfflineStatus, type StoreUsage } from "@/features/offline/store";

/** Settings: how much the offline reading store holds (+ the browser's quota) and a way to empty it. */
export function OfflineStorageControls() {
  const t = useTranslations("settings");
  const [usage, setUsage] = useState<StoreUsage | null>(null);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [status, setStatus] = useState<OfflineStatus | null>(null);

  const refresh = useCallback(async () => {
    const user = await getActiveUser();
    setUsage(user ? await getUsage(user) : { count: 0, bytes: 0 });
    setEstimate(await readStorageEstimate());
    setStatus((await readStatus()) ?? null);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col gap-2 sm:items-end" data-testid="offline-storage">
      <p className="text-body-sm text-muted-foreground" data-testid="offline-usage">
        {usage === null ? "…" : usage.count === 0 ? t("offlineUsageEmpty") : t("offlineUsage", { count: usage.count, size: formatBytes(usage.bytes) })}
      </p>
      {estimate?.usage != null && estimate.quota != null && (
        <p className="text-footnote text-muted-foreground">
          {t("offlineBrowserStorage", { used: formatBytes(estimate.usage), quota: formatBytes(estimate.quota) })}
        </p>
      )}
      {status?.quotaFailed && (
        <p className="text-footnote text-destructive" role="status" data-testid="offline-quota-warning">
          {t("offlineQuotaFailed")}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={!usage?.count}
        onClick={async () => {
          await clearOfflineArticles();
          await refresh();
        }}
      >
        {t("offlineClear")}
      </Button>
    </div>
  );
}
