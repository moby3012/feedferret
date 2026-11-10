"use client";

import { useTranslations } from "next-intl";
import { Send, Bell, Rss } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNotificationChannels, useUpdateNotificationChannels, useTestNotificationChannel } from "@/hooks/use-rss-data";
import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

export function NotificationChannelsSection() {
  const t = useTranslations();
  const { data, isLoading } = useNotificationChannels();
  const update = useUpdateNotificationChannels();
  const testChannel = useTestNotificationChannel();

  const [form, setForm] = useState({
    telegramEnabled: false,
    telegramBotToken: "",
    telegramChatId: "",
    gotifyEnabled: false,
    gotifyUrl: "",
    gotifyToken: "",
    ntfyEnabled: false,
    ntfyUrl: "",
    ntfyToken: "",
  });

  useEffect(() => {
    if (data) setForm({ ...data });
  }, [data]);

  function field(key: keyof typeof form) {
    return {
      value: form[key] as string,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setForm((prev) => ({ ...prev, [key]: e.target.value })),
    };
  }

  function toggle(key: keyof typeof form) {
    return (checked: boolean) => setForm((prev) => ({ ...prev, [key]: checked }));
  }

  async function save() {
    update.mutate(form);
  }

  async function test(channel: "telegram" | "gotify" | "ntfy") {
    // Save first so credentials are persisted before testing
    await update.mutateAsync(form);
    const result = await testChannel.mutateAsync(channel);
    if (result.success) {
      toast.success(t("notifications.successTitle"));
    } else {
      toast.error(result.error ?? t("notifications.errorTitle"));
    }
  }

  if (isLoading) return null;

  return (
    <section className="rounded-2xl border border-border/65 bg-card/85 shadow-sm">
      <div className="flex items-start gap-4 p-5 sm:p-6">
        <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
          <Bell className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold tracking-title">{t("notifications.title")}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {t("notifications.description")}
          </p>
        </div>
      </div>

      <div className="space-y-px">
        {/* Telegram */}
        <div className="border-t border-border/40 px-5 py-4 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Send className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Telegram</span>
            </div>
            <Switch
              checked={form.telegramEnabled}
              onCheckedChange={toggle("telegramEnabled")}
            />
          </div>
          {form.telegramEnabled && (
            <div className="mt-3 space-y-2">
              <div className="space-y-1">
                <Label htmlFor="telegram-bot-token" className="text-sm font-medium">{t("notifications.botTokenPlaceholder")}</Label>
                <Input
                  id="telegram-bot-token"
                  placeholder={t("notifications.botTokenPlaceholder")}
                  {...field("telegramBotToken")}
                  className="h-9 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="telegram-chat-id" className="text-sm font-medium">{t("notifications.chatIdPlaceholder")}</Label>
                <Input
                  id="telegram-chat-id"
                  placeholder={t("notifications.chatIdPlaceholder")}
                  {...field("telegramChatId")}
                  className="h-9 font-mono text-xs"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t("notifications.telegramHint")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => test("telegram")}
                disabled={testChannel.isPending || update.isPending || !form.telegramBotToken || !form.telegramChatId}
                className="h-8 rounded-xl text-xs"
              >
                {t("notifications.sendTestMessage")}
              </Button>
            </div>
          )}
        </div>

        {/* Gotify */}
        <div className="border-t border-border/40 px-5 py-4 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Gotify</span>
            </div>
            <Switch
              checked={form.gotifyEnabled}
              onCheckedChange={toggle("gotifyEnabled")}
            />
          </div>
          {form.gotifyEnabled && (
            <div className="mt-3 space-y-2">
              <div className="space-y-1">
                <Label htmlFor="gotify-server-url" className="text-sm font-medium">{t("notifications.serverUrlPlaceholder")}</Label>
                <Input
                  id="gotify-server-url"
                  placeholder={t("notifications.serverUrlPlaceholder")}
                  {...field("gotifyUrl")}
                  className="h-9 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gotify-app-token" className="text-sm font-medium">{t("notifications.appToken")}</Label>
                <Input
                  id="gotify-app-token"
                  placeholder={t("notifications.appToken")}
                  {...field("gotifyToken")}
                  className="h-9 font-mono text-xs"
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => test("gotify")}
                disabled={testChannel.isPending || update.isPending || !form.gotifyUrl || !form.gotifyToken}
                className="h-8 rounded-xl text-xs"
              >
                {t("notifications.sendTestNotification")}
              </Button>
            </div>
          )}
        </div>

        {/* ntfy */}
        <div className="border-t border-border/40 px-5 py-4 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Rss className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">ntfy</span>
            </div>
            <Switch
              checked={form.ntfyEnabled}
              onCheckedChange={toggle("ntfyEnabled")}
            />
          </div>
          {form.ntfyEnabled && (
            <div className="mt-3 space-y-2">
              <div className="space-y-1">
                <Label htmlFor="ntfy-topic-url" className="text-sm font-medium">{t("notifications.topicUrlPlaceholder")}</Label>
                <Input
                  id="ntfy-topic-url"
                  placeholder={t("notifications.topicUrlPlaceholder")}
                  {...field("ntfyUrl")}
                  className="h-9 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ntfy-token" className="text-sm font-medium">{t("notifications.tokenOptionalPlaceholder")}</Label>
                <Input
                  id="ntfy-token"
                  placeholder={t("notifications.tokenOptionalPlaceholder")}
                  {...field("ntfyToken")}
                  className="h-9 font-mono text-xs"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t("notifications.ntfyHint")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => test("ntfy")}
                disabled={testChannel.isPending || update.isPending || !form.ntfyUrl}
                className="h-8 rounded-xl text-xs"
              >
                {t("notifications.sendTestNotification")}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border/40 px-5 py-4 sm:px-6">
        <Button
          type="button"
          onClick={save}
          disabled={update.isPending}
          className="h-9 rounded-2xl px-5 text-sm"
        >
          {update.isPending ? t("notifications.saving") : t("notifications.saveChannels")}
        </Button>
      </div>
    </section>
  );
}
