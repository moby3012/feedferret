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

type TokenKey = "telegramBotToken" | "gotifyToken" | "ntfyToken";
const HAS_TOKEN = {
  telegramBotToken: "hasTelegramBotToken",
  gotifyToken: "hasGotifyToken",
  ntfyToken: "hasNtfyToken",
} as const;
const NO_REMOVALS: Record<TokenKey, boolean> = { telegramBotToken: false, gotifyToken: false, ntfyToken: false };

export function NotificationChannelsSection() {
  const t = useTranslations();
  const { data, isLoading } = useNotificationChannels();
  const update = useUpdateNotificationChannels();
  const testChannel = useTestNotificationChannel();

  // Tokens are write-only: the server only reports whether one is saved
  // (`has…Token`). An empty field keeps the saved token; "Remove" clears it.
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
  const [removed, setRemoved] = useState<Record<TokenKey, boolean>>(NO_REMOVALS);

  useEffect(() => {
    if (!data) return;
    setForm({
      telegramEnabled: data.telegramEnabled,
      telegramBotToken: "",
      telegramChatId: data.telegramChatId,
      gotifyEnabled: data.gotifyEnabled,
      gotifyUrl: data.gotifyUrl,
      gotifyToken: "",
      ntfyEnabled: data.ntfyEnabled,
      ntfyUrl: data.ntfyUrl,
      ntfyToken: "",
    });
    setRemoved(NO_REMOVALS);
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

  function isSaved(key: TokenKey) {
    return Boolean(data?.[HAS_TOKEN[key]]) && !removed[key];
  }

  function hasToken(key: TokenKey) {
    return form[key].trim().length > 0 || isSaved(key);
  }

  function tokenValue(key: TokenKey): string | null | undefined {
    if (form[key].trim()) return form[key];
    return removed[key] ? null : undefined;
  }

  function payload() {
    return {
      telegramEnabled: form.telegramEnabled,
      telegramBotToken: tokenValue("telegramBotToken"),
      telegramChatId: form.telegramChatId,
      gotifyEnabled: form.gotifyEnabled,
      gotifyUrl: form.gotifyUrl,
      gotifyToken: tokenValue("gotifyToken"),
      ntfyEnabled: form.ntfyEnabled,
      ntfyUrl: form.ntfyUrl,
      ntfyToken: tokenValue("ntfyToken"),
    };
  }

  function tokenInput(key: TokenKey, id: string, placeholder: string) {
    const saved = isSaved(key) && !form[key];
    return (
      <>
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="off"
            placeholder={saved ? t("notifications.tokenSavedPlaceholder") : placeholder}
            {...field(key)}
            className="h-9 font-mono text-footnote"
          />
          {saved && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setRemoved((prev) => ({ ...prev, [key]: true }))}
              className="h-9 shrink-0 rounded-panel text-footnote"
            >
              {t("notifications.removeToken")}
            </Button>
          )}
        </div>
        {removed[key] && !form[key] && (
          <p className="text-footnote text-muted-foreground">{t("notifications.tokenRemovedOnSave")}</p>
        )}
      </>
    );
  }

  async function save() {
    update.mutate(payload());
  }

  async function test(channel: "telegram" | "gotify" | "ntfy") {
    // Save first so credentials are persisted before testing
    await update.mutateAsync(payload());
    const result = await testChannel.mutateAsync(channel);
    if (result.success) {
      toast.success(t("notifications.successTitle"));
    } else {
      toast.error(result.error ?? t("notifications.errorTitle"));
    }
  }

  if (isLoading) return null;

  return (
    <section className="rounded-panel border border-border/65 bg-card/85">
      <div className="flex items-start gap-4 p-5 sm:p-6">
        <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-panel">
          <Bell className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h2 className="text-title-sm font-semibold tracking-title">{t("notifications.title")}</h2>
          <p className="mt-1 text-body-sm leading-6 text-muted-foreground">
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
                <Label htmlFor="telegram-bot-token" className="text-body-sm font-medium">{t("notifications.botTokenPlaceholder")}</Label>
                {tokenInput("telegramBotToken", "telegram-bot-token", t("notifications.botTokenPlaceholder"))}
              </div>
              <div className="space-y-1">
                <Label htmlFor="telegram-chat-id" className="text-body-sm font-medium">{t("notifications.chatIdPlaceholder")}</Label>
                <Input
                  id="telegram-chat-id"
                  placeholder={t("notifications.chatIdPlaceholder")}
                  {...field("telegramChatId")}
                  className="h-9 font-mono text-footnote"
                />
              </div>
              <p className="text-footnote text-muted-foreground">
                {t("notifications.telegramHint")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => test("telegram")}
                disabled={testChannel.isPending || update.isPending || !hasToken("telegramBotToken") || !form.telegramChatId}
                className="h-8 rounded-panel text-footnote"
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
                <Label htmlFor="gotify-server-url" className="text-body-sm font-medium">{t("notifications.serverUrlPlaceholder")}</Label>
                <Input
                  id="gotify-server-url"
                  placeholder={t("notifications.serverUrlPlaceholder")}
                  {...field("gotifyUrl")}
                  className="h-9 font-mono text-footnote"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gotify-app-token" className="text-body-sm font-medium">{t("notifications.appToken")}</Label>
                {tokenInput("gotifyToken", "gotify-app-token", t("notifications.appToken"))}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => test("gotify")}
                disabled={testChannel.isPending || update.isPending || !form.gotifyUrl || !hasToken("gotifyToken")}
                className="h-8 rounded-panel text-footnote"
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
                <Label htmlFor="ntfy-topic-url" className="text-body-sm font-medium">{t("notifications.topicUrlPlaceholder")}</Label>
                <Input
                  id="ntfy-topic-url"
                  placeholder={t("notifications.topicUrlPlaceholder")}
                  {...field("ntfyUrl")}
                  className="h-9 font-mono text-footnote"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ntfy-token" className="text-body-sm font-medium">{t("notifications.tokenOptionalPlaceholder")}</Label>
                {tokenInput("ntfyToken", "ntfy-token", t("notifications.tokenOptionalPlaceholder"))}
              </div>
              <p className="text-footnote text-muted-foreground">
                {t("notifications.ntfyHint")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => test("ntfy")}
                disabled={testChannel.isPending || update.isPending || !form.ntfyUrl}
                className="h-8 rounded-panel text-footnote"
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
          className="h-9 rounded-panel px-5 text-body-sm"
        >
          {update.isPending ? t("notifications.saving") : t("notifications.saveChannels")}
        </Button>
      </div>
    </section>
  );
}
