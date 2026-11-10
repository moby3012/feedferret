"use client";

import { useTranslations } from "next-intl";
import { Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useFeeds } from "@/hooks/use-rss-data";
import { useState, useCallback, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

type PushStatus = {
  configured: boolean;
  publicKey: string;
  activeSubscriptions: number;
  settings: {
    pushEnabled: boolean;
    pushFrequency: string;
    pushFeedIds: string[];
    pushPrivatePayloads: boolean;
    pushLastSentAt: string | null;
  };
};

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

export function PushNotificationSection() {
  const t = useTranslations();
  const { data: feeds = [] } = useFeeds();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const supported =
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window;

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/push/status");
      if (res.ok) setStatus(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const updateSettings = useCallback(
    async (patch: Partial<PushStatus["settings"]>) => {
      const next = {
        ...(status?.settings ?? {
          pushEnabled: false,
          pushFrequency: "immediate",
          pushFeedIds: [],
          pushPrivatePayloads: true,
          pushLastSentAt: null,
        }),
        ...patch,
      };
      setStatus((current) => current ? { ...current, settings: next } : current);
      const res = await fetch("/api/push/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        toast.error(t("push.toasts.couldNotSaveSettings"));
        await loadStatus();
      }
    },
    [loadStatus, status?.settings, t],
  );

  const enable = useCallback(async () => {
    if (!supported || !status?.publicKey) return;
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast.error(t("push.toasts.permissionNotGranted"));
        return;
      }
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(status.publicKey),
        }));

      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription,
          platform: navigator.platform,
          frequency: status.settings.pushFrequency || "immediate",
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(t("push.toasts.enabled"));
      await loadStatus();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("push.toasts.couldNotEnable"));
    } finally {
      setBusy(false);
    }
  }, [loadStatus, status, supported, t]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.ready : null;
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription?.endpoint }),
      });
      await subscription?.unsubscribe();
      toast.success(t("push.toasts.disabled"));
      await loadStatus();
    } finally {
      setBusy(false);
    }
  }, [loadStatus, t]);

  const sendTest = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      toast.success(t("push.toasts.testSent"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("push.toasts.couldNotSendTest"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const permission =
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported";
  const enabled = Boolean(status?.settings.pushEnabled && status.activeSubscriptions > 0);
  const feedIds = new Set(status?.settings.pushFeedIds ?? []);

  // Hide when push server not configured and we've finished loading (#13)
  if (!loading && status && !status.configured) return null;

  return (
    <section className="rounded-2xl border border-border/65 bg-card/85 p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
              {enabled ? <Bell className="h-5 w-5" /> : <BellOff className="h-5 w-5" />}
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-title">{t("push.title")}</h2>
              <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                {t("push.description")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("push.status")}: {loading ? t("push.checking") : !supported ? t("push.unsupported") : !status?.configured ? t("push.serverNotConfigured") : permission}
                {status ? ` · ${status.activeSubscriptions} ${status.activeSubscriptions === 1 ? t("push.activeDevice") : t("push.activeDevices")}` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {!enabled ? (
              <Button
                type="button"
                onClick={enable}
                disabled={busy || loading || !supported || !status?.configured}
                className="h-11 rounded-2xl px-5"
              >
                {t("push.enable")}
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={sendTest} disabled={busy} className="h-11 rounded-2xl px-5">
                  {t("push.test")}
                </Button>
                <Button type="button" variant="outline" onClick={disable} disabled={busy} className="h-11 rounded-2xl px-5">
                  {t("push.disableDevice")}
                </Button>
              </>
            )}
          </div>
        </div>

        {status && (
          <div className="ui-control-surface grid gap-4 rounded-panel border p-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="push-frequency-select">{t("push.frequency")}</label>
              <Select
                value={status.settings.pushFrequency}
                onValueChange={(value) => updateSettings({ pushFrequency: value })}
              >
                <SelectTrigger id="push-frequency-select" className="rounded-2xl border-border/70 bg-background/70">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-2xl">
                  <SelectItem value="immediate">{t("push.frequencies.immediately")}</SelectItem>
                  <SelectItem value="hourly">{t("push.frequencies.hourly")}</SelectItem>
                  <SelectItem value="daily">{t("push.frequencies.daily")}</SelectItem>
                  <SelectItem value="off">{t("push.frequencies.off")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="ui-control-surface flex items-center justify-between rounded-2xl border px-4 py-3">
              <div>
                <p className="text-sm font-medium">{t("push.includeArticleTitles")}</p>
                <p className="text-xs text-muted-foreground">{t("push.includeArticleTitlesDescription")}</p>
              </div>
              <Switch
                checked={status.settings.pushPrivatePayloads}
                onCheckedChange={(checked) => updateSettings({ pushPrivatePayloads: checked })}
              />
            </div>
            <div className="sm:col-span-2">
              <p className="mb-2 text-sm font-medium">{t("push.feeds")}</p>
              <div className="max-h-44 overflow-y-auto rounded-2xl border border-border/70 bg-background/70 p-3">
                <label className="mb-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={feedIds.size === 0}
                    onChange={() => updateSettings({ pushFeedIds: [] })}
                  />
                  {t("push.allFeeds")}
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {feeds.map((feed: any) => (
                    <label
                      key={feed.id}
                      className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
                      title={feed.name}
                    >
                      <input
                        type="checkbox"
                        className="shrink-0"
                        checked={feedIds.size === 0 || feedIds.has(feed.id)}
                        onChange={(event) => {
                          const next = new Set(feedIds);
                          if (feedIds.size === 0) feeds.forEach((item: any) => next.add(item.id));
                          if (event.target.checked) next.add(feed.id);
                          else next.delete(feed.id);
                          updateSettings({ pushFeedIds: next.size === feeds.length ? [] : Array.from(next) });
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate">{feed.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
