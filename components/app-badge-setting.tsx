"use client";

import { useTranslations } from "next-intl";
import { BellDot } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { setAppBadgeEnabled, useAppBadgeEnabled } from "@/hooks/use-app-badge";

/** Settings → Benachrichtigungen: the unread count on the installed app's icon (per device, default on). */
export function AppBadgeSetting() {
  const t = useTranslations("settings.appBadge");
  const enabled = useAppBadgeEnabled();
  return (
    <section className="rounded-row border border-border/65 bg-card/85 p-5 shadow-sm sm:p-6" data-testid="app-badge-setting">
      <div className="flex items-start gap-4">
        <div className="ui-brand-icon flex size-12 shrink-0 items-center justify-center rounded-row">
          <BellDot className="size-5" />
        </div>
        <div className="flex min-w-0 flex-1 items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="app-badge-title" className="text-title-sm">
              {t("title")}
            </h2>
            <p id="app-badge-description" className="mt-1 max-w-xl text-body-sm text-muted-foreground">
              {t("description")}
            </p>
          </div>
          <Switch aria-labelledby="app-badge-title" aria-describedby="app-badge-description" checked={enabled} onCheckedChange={setAppBadgeEnabled} />
        </div>
      </div>
    </section>
  );
}
