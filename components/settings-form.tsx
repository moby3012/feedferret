"use client";

import { useTranslations } from "next-intl";
import { useSession, signOut } from "next-auth/react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import {
  AlignLeft,
  ALargeSmall,
  ArrowDownAZ,
  ArrowLeft,
  Clock,
  Copy,
  ExternalLink,
  Key,
  Languages,
  Laptop,
  Layers,
  LogOut,
  Mail,
  Moon,
  Palette,
  ScrollText,
  Send,
  Settings,
  Smartphone,
  Sun,
  Trash2,
  User,
  Shield,
  ShieldOff,
  AlertTriangle,
  Bell,
  BellOff,
  Keyboard,
  Sparkles,
  CheckCircle2,
  XCircle,
  Rss,
  ChevronDown,
  ChevronRight,
  Plus,
  EyeOff,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { deleteOwnAccount } from "@/app/actions/account";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useFormatter } from "next-intl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useReadingPreferences, useUpdateGlobalSettings, useUpdateUiLanguage, useDigestSettings, useUpdateDigestSettings, useSendTestDigest, usePreviewDigest, useFeeds, useLabels, useTwoFactorStatus, useBeginTwoFactorSetup, useConfirmTwoFactorSetup, useDisableTwoFactor, useAiSettings, useUpdateAiSettings, useTestAiConnection, useNotificationChannels, useUpdateNotificationChannels, useTestNotificationChannel } from "@/hooks/use-rss-data";
import { useInstance } from "@/hooks/use-instance";
import { useState, useCallback, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { ResponsiveTabsNav } from "@/components/responsive-tabs-nav";
import { MobileFloatingBackButton } from "@/components/mobile-floating-back-button";
import { toast } from "sonner";
import { SHOW_PWA_INSTALL_PROMPT_EVENT } from "@/components/pwa-install-prompt";

function makeThemeOptions(t: ReturnType<typeof useTranslations>) {
  return [
    { id: "light", label: t("settings.themeOptions.light"), icon: Sun },
    { id: "dark", label: t("settings.themeOptions.dark"), icon: Moon },
    { id: "system", label: t("settings.themeOptions.system"), icon: Laptop },
  ];
}

function normalizeDefaultViewMode(value?: string | null) {
  if (value === "minimal" || value === "magazine" || value === "list") {
    return value;
  }
  if (value === "grid") {
    return "magazine";
  }
  return "list";
}

function PrefRow({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: any;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.02em]">{title}</h2>
            <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="w-full shrink-0 sm:w-auto">{children}</div>
      </div>
    </section>
  );
}

export function SettingsForm() {
  const t = useTranslations();
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const { data: prefs } = useReadingPreferences();
  const updateSettings = useUpdateGlobalSettings();
  const themeOptions = makeThemeOptions(t);
  const updateUiLang = useUpdateUiLanguage();

  const update = (data: Parameters<typeof updateSettings.mutate>[0]) =>
    updateSettings.mutate(data);

  const [activeTab, setActiveTab] = useState("appearance");

  const tabOptions = [
    { value: "appearance", label: t("settings.tabs.appearance"), icon: <Palette className="h-4 w-4 shrink-0" /> },
    { value: "reading", label: t("settings.tabs.reading"), icon: <ScrollText className="h-4 w-4 shrink-0" /> },
    { value: "account", label: t("settings.tabs.account"), icon: <User className="h-4 w-4 shrink-0" /> },
    { value: "notifications", label: t("settings.tabs.notifications"), icon: <Bell className="h-4 w-4 shrink-0" /> },
    { value: "integrations", label: t("settings.tabs.integrations"), icon: <Rss className="h-4 w-4 shrink-0" /> },
  ];

  return (
    <main className="min-h-dvh app-chrome text-foreground overflow-x-hidden">
      <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 py-6 pb-24 sm:px-6 lg:px-8 lg:pb-6">
        <header className="mb-8 flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.back()}
            className="h-11 w-11 rounded-2xl bg-card/70 backdrop-blur-xl border border-border/60 shadow-sm"
            aria-label={t("settings.back")}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Settings className="h-4 w-4" />
              {t("settings.breadcrumb")}
            </div>
            <h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              {t("settings.title")}
            </h1>
          </div>
        </header>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <ResponsiveTabsNav
            value={activeTab}
            onValueChange={setActiveTab}
            options={tabOptions}
            className="mb-6"
            triggerClassName="gap-1.5"
          />

          {/* ── Tab: Appearance ── */}
          <TabsContent value="appearance" className="grid gap-5">

            {/* Theme */}
            <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
              <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-4">
                  <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
                    <Palette className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold tracking-[-0.02em]">{t("settings.appearance")}</h2>
                    <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                      {t("settings.chooseVisualMode")}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1 rounded-2xl border border-border/70 bg-muted/45 p-1 shadow-inner shadow-black/[0.02]">
                  {themeOptions.map((option) => {
                    const Icon = option.icon;
                    const active = theme === option.id;
                    return (
                      <button
                        key={option.id}
                        onClick={() => setTheme(option.id)}
                        className={cn(
                          "inline-flex h-10 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium transition-all",
                          active
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="hidden sm:inline">{option.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* Accent colors */}
            <PrefRow
              icon={Palette}
              title={t("settings.accentColors")}
              description={t("settings.accentColorsDescription")}
            >
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-sm text-muted-foreground" htmlFor="accent-color-primary">{t("settings.primary")}</label>
                  <input
                    id="accent-color-primary"
                    type="color"
                    value={prefs?.accentColor ?? "#5BA4CF"}
                    onChange={(e) => update({ accentColor: e.target.value })}
                    className="w-10 h-10 rounded-xl border border-border/70 cursor-pointer bg-transparent p-0.5"
                    title={t("settings.primary")}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-muted-foreground" htmlFor="accent-color-secondary">{t("settings.secondary")}</label>
                  <input
                    id="accent-color-secondary"
                    type="color"
                    value={prefs?.secondaryColor ?? "#F0963C"}
                    onChange={(e) => update({ secondaryColor: e.target.value })}
                    className="w-10 h-10 rounded-xl border border-border/70 cursor-pointer bg-transparent p-0.5"
                    title={t("settings.secondary")}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => update({ accentColor: "#5BA4CF", secondaryColor: "#F0963C" })}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t("settings.reset")}
                </button>
                <div
                  className="w-full min-w-[180px] rounded-2xl border border-border/70 p-3 shadow-sm sm:ml-auto sm:w-auto"
                  style={{
                    background: `linear-gradient(135deg, ${(prefs?.accentColor ?? "#5BA4CF")}22 0%, ${(prefs?.secondaryColor ?? "#F0963C")}2a 100%)`,
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        {t("settings.preview")}
                      </p>
                      <p className="text-sm font-medium">{t("settings.appAccents")}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className="h-7 w-7 rounded-full border border-white/40 shadow-sm"
                        style={{ backgroundColor: prefs?.accentColor ?? "#5BA4CF" }}
                      />
                      <span
                        className="h-7 w-7 rounded-full border border-white/40 shadow-sm"
                        style={{ backgroundColor: prefs?.secondaryColor ?? "#F0963C" }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </PrefRow>

            {/* Default view mode */}
            <PrefRow
              icon={AlignLeft}
              title={t("settings.defaultView")}
              description={t("settings.defaultViewDescription")}
            >
              <Select
                value={normalizeDefaultViewMode(prefs?.defaultViewMode)}
                onValueChange={(v) => update({ defaultViewMode: v })}
              >
                <SelectTrigger className="h-10 w-full rounded-2xl border-border/70 bg-background/70 sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-2xl">
                  <SelectItem value="list">{t("settings.viewOptions.list")}</SelectItem>
                  <SelectItem value="magazine">{t("settings.viewOptions.magazine")}</SelectItem>
                  <SelectItem value="minimal">{t("settings.viewOptions.minimal")}</SelectItem>
                </SelectContent>
              </Select>
            </PrefRow>

            {/* Reader width */}
            <PrefRow
              icon={AlignLeft}
              title={t("settings.readerWidth")}
              description={t("settings.readerWidthDescription")}
            >
              <Select
                value={prefs?.readerWidth ?? "normal"}
                onValueChange={(v) => update({ readerWidth: v })}
              >
                <SelectTrigger className="h-10 w-full rounded-2xl border-border/70 bg-background/70 sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-2xl">
                  <SelectItem value="normal">{t("settings.widthOptions.normal")}</SelectItem>
                  <SelectItem value="wide">{t("settings.widthOptions.wide")}</SelectItem>
                  <SelectItem value="full">{t("settings.widthOptions.full")}</SelectItem>
                </SelectContent>
              </Select>
            </PrefRow>

            {/* Reader font size */}
            <PrefRow
              icon={ALargeSmall}
              title={t("settings.readerFontSize")}
              description={t("settings.readerFontSizeDescription")}
            >
              <Select
                value={prefs?.readerFontSize ?? "medium"}
                onValueChange={(v) => update({ readerFontSize: v })}
              >
                <SelectTrigger className="h-10 w-full rounded-2xl border-border/70 bg-background/70 sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-2xl">
                  <SelectItem value="small">{t("settings.fontSizeOptions.small")}</SelectItem>
                  <SelectItem value="medium">{t("settings.fontSizeOptions.medium")}</SelectItem>
                  <SelectItem value="large">{t("settings.fontSizeOptions.large")}</SelectItem>
                  <SelectItem value="xl">{t("settings.fontSizeOptions.xl")}</SelectItem>
                </SelectContent>
              </Select>
            </PrefRow>

          </TabsContent>

          {/* ── Tab: Reading ── */}
          <TabsContent value="reading" className="grid gap-5">

            {/* Default sort order */}
            <PrefRow
              icon={ArrowDownAZ}
              title={t("settings.defaultSort")}
              description={t("settings.defaultSortDescription")}
            >
              <Select
                value={prefs?.defaultArticleSort ?? "newest"}
                onValueChange={(v) => update({ defaultArticleSort: v })}
              >
                <SelectTrigger className="h-10 w-full rounded-2xl border-border/70 bg-background/70 sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-2xl">
                  <SelectItem value="newest">{t("settings.sortOptions.newest")}</SelectItem>
                  <SelectItem value="oldest">{t("settings.sortOptions.oldest")}</SelectItem>
                </SelectContent>
              </Select>
            </PrefRow>

            {/* Mark-as-read delay */}
            <PrefRow
              icon={Clock}
              title={t("settings.markAsRead")}
              description={t("settings.markAsReadDescription")}
            >
              <Select
                value={
                  prefs?.markReadAfterDelaySecs === 0
                    ? "off"
                    : prefs?.markReadAfterDelaySecs === null || prefs?.markReadAfterDelaySecs === undefined
                    ? "instant"
                    : String(prefs.markReadAfterDelaySecs)
                }
                onValueChange={(v) =>
                  update({
                    markReadAfterDelaySecs: v === "off" ? 0 : v === "instant" ? null : parseInt(v),
                  })
                }
              >
                <SelectTrigger className="h-10 w-full rounded-2xl border-border/70 bg-background/70 sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-2xl">
                  <SelectItem value="instant">{t("settings.markReadOptions.instant")}</SelectItem>
                  <SelectItem value="5">{t("settings.markReadOptions.after5s")}</SelectItem>
                  <SelectItem value="15">{t("settings.markReadOptions.after15s")}</SelectItem>
                  <SelectItem value="30">{t("settings.markReadOptions.after30s")}</SelectItem>
                  <SelectItem value="60">{t("settings.markReadOptions.after60s")}</SelectItem>
                  <SelectItem value="off">{t("settings.markReadOptions.off")}</SelectItem>
                </SelectContent>
              </Select>
            </PrefRow>

            {/* Mark as read on scroll */}
            <PrefRow
              icon={ScrollText}
              title={t("settings.markAsReadOnScroll")}
              description={t("settings.markAsReadOnScrollDescription")}
            >
              <Switch
                checked={prefs?.markReadOnScroll ?? false}
                onCheckedChange={(checked) => update({ markReadOnScroll: checked })}
                className="h-7 w-12"
              />
            </PrefRow>

            {/* Open original */}
            <PrefRow
              icon={ExternalLink}
              title={t("settings.openOriginal")}
              description={t("settings.openOriginalDescription")}
            >
              <Switch
                checked={prefs?.openOriginalByDefault ?? false}
                onCheckedChange={(checked) => update({ openOriginalByDefault: checked })}
                className="h-7 w-12"
              />
            </PrefRow>

            {/* Hide duplicates */}
            <PrefRow
              icon={Layers}
              title={t("settings.hideDuplicates")}
              description={t("settings.hideDuplicatesDescription")}
            >
              <Switch
                checked={prefs?.hideDuplicates ?? true}
                onCheckedChange={(checked) => update({ hideDuplicates: checked })}
                className="h-7 w-12"
              />
            </PrefRow>

            {/* RTL layout */}
            <PrefRow
              icon={AlignLeft}
              title={t("settings.rtlLayout")}
              description={t("settings.rtlLayoutDescription")}
            >
              <Switch
                checked={(prefs?.layoutDirection ?? "ltr") === "rtl"}
                onCheckedChange={(checked) => update({ layoutDirection: checked ? "rtl" : "ltr" })}
                className="h-7 w-12"
              />
            </PrefRow>

            {/* Language */}
            <PrefRow
              icon={Languages}
              title="Language"
              description="Interface language for the app. Takes effect after navigating away and back."
            >
              <Select
                value={prefs?.uiLanguage ?? "en"}
                onValueChange={(locale) => {
                  updateUiLang.mutate(locale, {
                    onSuccess: () => router.refresh(),
                  });
                }}
              >
                <SelectTrigger className="h-10 w-full rounded-2xl border-border/70 bg-background/70 sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-2xl">
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="de">Deutsch</SelectItem>
                </SelectContent>
              </Select>
            </PrefRow>

            {/* Hide empty feeds */}
            <PrefRow
              icon={EyeOff}
              title={t("settings.hideEmptyFeeds")}
              description={t("settings.hideEmptyFeedsDescription")}
            >
              <Switch
                checked={prefs?.hideEmptyFeeds ?? false}
                onCheckedChange={(checked) => update({ hideEmptyFeeds: checked })}
                className="h-7 w-12"
              />
            </PrefRow>

            {/* Hide empty labels */}
            <PrefRow
              icon={EyeOff}
              title={t("settings.hideEmptyLabels")}
              description={t("settings.hideEmptyLabelsDescription")}
            >
              <Switch
                checked={prefs?.hideEmptyLabels ?? false}
                onCheckedChange={(checked) => update({ hideEmptyLabels: checked })}
                className="h-7 w-12"
              />
            </PrefRow>

          </TabsContent>

          {/* ── Tab: Account ── */}
          <TabsContent value="account" className="grid gap-5">

            {/* User Profile */}
            <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
              <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <User className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold tracking-[-0.02em]">{t("settings.userProfile")}</h2>
                    <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                      {t("settings.signedInAs")}{" "}
                      <span className="font-medium text-foreground">
                        {session?.user?.email || t("settings.unknownUser")}
                      </span>
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={() => signOut({ callbackUrl: "/" })}
                  className="h-11 rounded-2xl border-border/70 bg-background/70 px-5"
                >
                  <LogOut className="me-2 h-4 w-4" />
                  {t("settings.signOut")}
                </Button>
              </div>
            </section>

            {/* Two-factor authentication */}
            <TwoFactorSection />

            {/* API Access */}
            <ApiTokenSection />

            {/* Add to Home Screen */}
            <PrefRow
              icon={Smartphone}
              title={t("pwa.title")}
              description={t("pwa.description")}
            >
              <Button
                type="button"
                variant="outline"
                onClick={() => window.dispatchEvent(new Event(SHOW_PWA_INSTALL_PROMPT_EVENT))}
                className="h-11 rounded-2xl border-border/70 bg-background/70 px-5"
              >
                {t("pwa.showInstructions")}
              </Button>
            </PrefRow>

            {/* Keyboard shortcuts */}
            <PrefRow
              icon={Keyboard}
              title={t("keyboard.title")}
              description={t("keyboard.description")}
            >
              <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground sm:min-w-80">
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <span className="font-mono text-foreground">j / k</span>
                  <span>{t("keyboard.nextArticle")} / {t("keyboard.previousArticle")}</span>
                  <span className="font-mono text-foreground">n / p</span>
                  <span>{t("keyboard.nextUnread")} / {t("keyboard.previousUnread")}</span>
                  <span className="font-mono text-foreground">m / s</span>
                  <span>{t("keyboard.toggleRead")} / {t("keyboard.toggleStar")}</span>
                  <span className="font-mono text-foreground">/</span>
                  <span>{t("keyboard.focusSearch")}</span>
                  <span className="font-mono text-foreground">?</span>
                  <span>{t("keyboard.toggleHelp")}</span>
                </div>
              </div>
            </PrefRow>

            {/* Danger Zone: Delete Account */}
            <DeleteAccountSection />

          </TabsContent>

          {/* ── Tab: Notifications ── */}
          <TabsContent value="notifications" className="grid gap-5">
            <PushNotificationSection />
            <DigestSection />
            <NotificationChannelsSection />
          </TabsContent>

          {/* ── Tab: Integrations ── */}
          <TabsContent value="integrations" className="grid gap-5">
            <AiSummarySection />
            <SyncTutorialSection />
          </TabsContent>

        </Tabs>
      </div>
      <MobileFloatingBackButton fallbackHref="/" />
    </main>
  );
}

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

function PushNotificationSection() {
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
    <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
              {enabled ? <Bell className="h-5 w-5" /> : <BellOff className="h-5 w-5" />}
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-[-0.02em]">{t("push.title")}</h2>
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
          <div className="grid gap-4 rounded-[1.5rem] border border-border/70 bg-background/60 p-4 sm:grid-cols-2">
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
            <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/20 px-4 py-3">
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


function TwoFactorSection() {
  const t = useTranslations();
  const { data: status } = useTwoFactorStatus();
  const beginSetup = useBeginTwoFactorSetup();
  const confirmSetup = useConfirmTwoFactorSetup();
  const disableTwoFactor = useDisableTwoFactor();
  const [setupData, setSetupData] = useState<{ secret: string; uri: string; issuer: string; accountName: string } | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [disableCode, setDisableCode] = useState("");

  const copyValue = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("twoFactor.copied", { label }));
    } catch {
      toast.error(t("twoFactor.couldNotCopy", { label: label.toLowerCase() }));
    }
  }, [t]);

  const handleBegin = async () => {
    try {
      const result = await beginSetup.mutateAsync();
      setSetupData(result);
      setSetupCode("");
    } catch {}
  };

  const handleEnable = async () => {
    try {
      await confirmSetup.mutateAsync(setupCode);
      setSetupData(null);
      setSetupCode("");
    } catch {}
  };

  const handleDisable = async () => {
    try {
      await disableTwoFactor.mutateAsync(disableCode);
      setDisableCode("");
    } catch {}
  };

  return (
    <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-[-0.02em]">{t("twoFactor.title")}</h2>
              <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                {t("twoFactor.description")}
              </p>
            </div>
          </div>
          {status?.enabled ? (
            <div className="inline-flex items-center gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              <Shield className="h-4 w-4" /> {t("twoFactor.enabled")}
            </div>
          ) : (
            <Button
              type="button"
              onClick={handleBegin}
              disabled={beginSetup.isPending}
              className="h-11 rounded-2xl px-5"
            >
              {beginSetup.isPending ? t("twoFactor.starting") : t("twoFactor.beginSetup")}
            </Button>
          )}
        </div>

        {setupData && !status?.enabled && (
          <div className="grid gap-4 rounded-[1.5rem] border border-border/70 bg-background/60 p-4 sm:p-5">
            <div className="grid gap-2">
              <p className="text-sm font-medium">{t("twoFactor.addToAuthApp")}</p>
              <p className="text-xs text-muted-foreground">
                {t("twoFactor.manualSetupHint")}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-border/70 bg-background/70 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("twoFactor.account")}</p>
                <p className="mt-1 text-sm font-medium break-all">{setupData.accountName}</p>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/70 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("twoFactor.secret")}</p>
                <div className="mt-1 flex items-center gap-2">
                  <p className="text-sm font-medium break-all">{setupData.secret}</p>
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8 rounded-xl" onClick={() => copyValue(setupData.secret, t("twoFactor.secret"))}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("twoFactor.otpauthUri")}</p>
                  <p className="mt-1 text-xs text-muted-foreground break-all">{setupData.uri}</p>
                </div>
                <Button type="button" variant="outline" className="rounded-2xl" onClick={() => copyValue(setupData.uri, "URI")}>
                  <Copy className="me-2 h-4 w-4" /> {t("twoFactor.copy")}
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="totp-setup-code">{t("twoFactor.enterCode")}</label>
                <Input
                  id="totp-setup-code"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="123456"
                  className="rounded-2xl border-border/70 bg-background/70"
                  value={setupCode}
                  onChange={(e) => setSetupCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="rounded-2xl" onClick={() => setSetupData(null)}>
                  {t("twoFactor.cancel")}
                </Button>
                <Button type="button" className="rounded-2xl" onClick={handleEnable} disabled={confirmSetup.isPending || setupCode.length !== 6}>
                  {confirmSetup.isPending ? t("twoFactor.enabling") : t("twoFactor.enableTwoFa")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {status?.enabled && (
          <div className="grid gap-4 rounded-[1.5rem] border border-border/70 bg-background/60 p-4 sm:p-5">
            <div className="flex items-start gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
              <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                {t("twoFactor.greaderWarning")}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="totp-disable-code">{t("twoFactor.disableTwoFa")}</label>
                <Input
                  id="totp-disable-code"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="123456"
                  className="rounded-2xl border-border/70 bg-background/70"
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                className="rounded-2xl border-destructive/30 text-destructive hover:bg-destructive/10"
                onClick={handleDisable}
                disabled={disableTwoFactor.isPending || disableCode.length !== 6}
              >
                {disableTwoFactor.isPending ? t("twoFactor.disabling") : t("twoFactor.disableTwoFa")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

const DAYS = [
  { value: "0", key: "digest.days.sunday" },
  { value: "1", key: "digest.days.monday" },
  { value: "2", key: "digest.days.tuesday" },
  { value: "3", key: "digest.days.wednesday" },
  { value: "4", key: "digest.days.thursday" },
  { value: "5", key: "digest.days.friday" },
  { value: "6", key: "digest.days.saturday" },
] as const;

const LOOKBACK_OPTIONS = [
  { value: "since_last", hours: null, key: "digest.lookbackOptions.sinceLast" },
  { value: "6", hours: 6, key: "digest.lookbackOptions.h6" },
  { value: "12", hours: 12, key: "digest.lookbackOptions.h12" },
  { value: "24", hours: 24, key: "digest.lookbackOptions.h24" },
  { value: "48", hours: 48, key: "digest.lookbackOptions.h48" },
  { value: "168", hours: 168, key: "digest.lookbackOptions.d7" },
  { value: "336", hours: 336, key: "digest.lookbackOptions.d14" },
  { value: "720", hours: 720, key: "digest.lookbackOptions.d30" },
] as const;

const ARTICLE_COUNT_OPTIONS = [5, 10, 15, 20, 30, 50, 75, 100];

function getCommonTimezones(): string[] {
  const common = [
    "UTC",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Paris",
    "Europe/Madrid",
    "Europe/Rome",
    "Europe/Amsterdam",
    "Europe/Stockholm",
    "Europe/Warsaw",
    "Europe/Moscow",
    "Europe/Istanbul",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Toronto",
    "America/Sao_Paulo",
    "America/Mexico_City",
    "Asia/Tokyo",
    "Asia/Shanghai",
    "Asia/Singapore",
    "Asia/Hong_Kong",
    "Asia/Seoul",
    "Asia/Kolkata",
    "Asia/Dubai",
    "Australia/Sydney",
    "Australia/Melbourne",
    "Pacific/Auckland",
    "Africa/Johannesburg",
    "Africa/Cairo",
  ];
  try {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browserTz && !common.includes(browserTz)) common.unshift(browserTz);
  } catch {}
  return common;
}

function DigestSection() {
  const t = useTranslations();
  const format = useFormatter();
  const { data: digest } = useDigestSettings();
  const { data: feedsData } = useFeeds();
  const { data: labelsData } = useLabels();
  const { data: instance, loading: instanceLoading } = useInstance();
  const updateDigest = useUpdateDigestSettings();
  const sendTest = useSendTestDigest();
  const preview = usePreviewDigest();

  if (!digest) return null;
  // Hide entirely if instance has no mail configured (#5)
  if (!instanceLoading && instance && !instance.capabilities.mail) return null;

  const feeds = feedsData ?? [];
  const labels = labelsData ?? [];

  const isPaused = !!digest.digestPausedUntil && new Date(digest.digestPausedUntil) > new Date();

  function update(data: Parameters<typeof updateDigest.mutate>[0]) {
    updateDigest.mutate(data);
  }

  function pauseUntil(days: number | null) {
    const until = days === null ? new Date(9999, 0, 1) : new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    update({ digestPausedUntil: until });
  }

  return (
    <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
      <div className="flex items-start gap-4 mb-6">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Mail className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.02em]">{t("digest.title")}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {t("digest.description")}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        {/* Enable toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t("digest.enableDigestEmails")}</p>
            {digest.digestLastSentAt && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("digest.lastSent")}: {format.dateTime(new Date(digest.digestLastSentAt), { dateStyle: "medium", timeStyle: "short" })}
              </p>
            )}
          </div>
          <button
            role="switch"
            aria-checked={digest.digestEnabled}
            onClick={() => update({ digestEnabled: !digest.digestEnabled })}
            className={cn(
              "relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
              digest.digestEnabled ? "bg-primary" : "bg-muted",
            )}
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200",
                digest.digestEnabled ? "translate-x-5" : "translate-x-0",
              )}
            />
          </button>
        </div>

        {digest.digestEnabled && (
          <>
            {/* Frequency / Day / Hour / Timezone */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider" htmlFor="digest-frequency-select">{t("digest.frequency")}</label>
                <Select
                  value={digest.digestFrequency}
                  onValueChange={(v) => update({ digestFrequency: v })}
                >
                  <SelectTrigger id="digest-frequency-select" className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    <SelectItem value="daily">{t("digest.frequencies.daily")}</SelectItem>
                    <SelectItem value="weekdays">{t("digest.frequencies.weekdays")}</SelectItem>
                    <SelectItem value="weekly">{t("digest.frequencies.weekly")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Day of week (weekly only) */}
              {digest.digestFrequency === "weekly" && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider" htmlFor="digest-day-select">{t("digest.day")}</label>
                  <Select
                    value={String(digest.digestDayOfWeek)}
                    onValueChange={(v) => update({ digestDayOfWeek: parseInt(v) })}
                  >
                    <SelectTrigger id="digest-day-select" className="rounded-2xl border-border/70 bg-background/70 h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="rounded-2xl">
                      {DAYS.map((d) => (
                        <SelectItem key={d.value} value={d.value}>{t(d.key)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Hour */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider" htmlFor="digest-hour-select">{t("digest.hour")}</label>
                <Select
                  value={String(digest.digestHour)}
                  onValueChange={(v) => update({ digestHour: parseInt(v) })}
                >
                  <SelectTrigger id="digest-hour-select" className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    {Array.from({ length: 24 }, (_, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {String(i).padStart(2, "0")}:00
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Timezone */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider" htmlFor="digest-timezone-select">{t("digest.timezone")}</label>
                <Select
                  value={digest.digestTimezone}
                  onValueChange={(v) => update({ digestTimezone: v })}
                >
                  <SelectTrigger id="digest-timezone-select" className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl max-h-72">
                    {getCommonTimezones().map((tz) => (
                      <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                    ))}
                    {!getCommonTimezones().includes(digest.digestTimezone) && (
                      <SelectItem value={digest.digestTimezone}>{digest.digestTimezone}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Scope / Lookback / Max / Min */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider" htmlFor="digest-scope-select">{t("digest.include")}</label>
                <Select
                  value={digest.digestScope}
                  onValueChange={(v) => update({ digestScope: v })}
                >
                  <SelectTrigger id="digest-scope-select" className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    <SelectItem value="unread">{t("digest.scope.unread")}</SelectItem>
                    <SelectItem value="all">{t("digest.scope.allNew")}</SelectItem>
                    <SelectItem value="starred">{t("digest.scope.starred")}</SelectItem>
                    <SelectItem value="readlater">{t("digest.scope.readLater")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider" htmlFor="digest-lookback-select">{t("digest.lookback")}</label>
                <Select
                  value={digest.digestLookbackHours === null ? "since_last" : String(digest.digestLookbackHours)}
                  onValueChange={(v) => {
                    const opt = LOOKBACK_OPTIONS.find((o) => o.value === v);
                    update({ digestLookbackHours: opt ? opt.hours : null });
                  }}
                >
                  <SelectTrigger id="digest-lookback-select" className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    {LOOKBACK_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{t(o.key)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider" htmlFor="digest-max-select">{t("digest.maxArticles")}</label>
                <Select
                  value={String(digest.digestMaxArticles)}
                  onValueChange={(v) => update({ digestMaxArticles: parseInt(v) })}
                >
                  <SelectTrigger id="digest-max-select" className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    {ARTICLE_COUNT_OPTIONS.map((n) => (
                      <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider" htmlFor="digest-min-select">{t("digest.minArticles")}</label>
                <Select
                  value={String(digest.digestMinArticles)}
                  onValueChange={(v) => update({ digestMinArticles: parseInt(v) })}
                >
                  <SelectTrigger id="digest-min-select" className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    {[1, 3, 5, 10, 20].map((n) => (
                      <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <p className="text-xs text-muted-foreground -mt-2">
              {t("digest.lookbackHint")} {t("digest.minArticlesHint")}
            </p>

            {/* Group by feed + AI summary */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex items-start justify-between rounded-2xl border border-border/70 bg-background/50 p-4">
                <div className="pr-3">
                  <p className="text-sm font-medium">{t("digest.groupByFeed")}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t("digest.groupByFeedHint")}</p>
                </div>
                <button
                  role="switch"
                  aria-checked={digest.digestGroupByFeed}
                  onClick={() => update({ digestGroupByFeed: !digest.digestGroupByFeed })}
                  className={cn(
                    "relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                    digest.digestGroupByFeed ? "bg-primary" : "bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200",
                      digest.digestGroupByFeed ? "translate-x-5" : "translate-x-0",
                    )}
                  />
                </button>
              </div>

              <div className="flex flex-col gap-1.5 rounded-2xl border border-border/70 bg-background/50 p-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-accent" />
                  <label className="text-sm font-medium" htmlFor="digest-ai-select">{t("digest.aiSummary")}</label>
                </div>
                <Select
                  value={digest.digestAiSummary}
                  onValueChange={(v) => update({ digestAiSummary: v })}
                  disabled={!digest.aiConfigured}
                >
                  <SelectTrigger id="digest-ai-select" className="rounded-xl border-border/70 bg-background/70 h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-xl">
                    <SelectItem value="none">{t("digest.aiSummaryModes.none")}</SelectItem>
                    <SelectItem value="full">{t("digest.aiSummaryModes.full")}</SelectItem>
                    <SelectItem value="per_feed">{t("digest.aiSummaryModes.perFeed")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {digest.aiConfigured ? t("digest.aiSummaryHint") : t("digest.aiNotConfigured")}
                </p>
              </div>
            </div>

            {/* Feed filter */}
            {feeds.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t("digest.feedFilter")}{" "}
                  <span className="normal-case font-normal">({t("digest.feedFilterHint")})</span>
                </label>
                <div className="flex flex-wrap gap-2 rounded-2xl border border-border/70 bg-background/50 p-3 min-h-[48px]">
                  {feeds.map((feed: any) => {
                    const selected = digest.digestFeedIds.includes(feed.id);
                    return (
                      <button
                        key={feed.id}
                        type="button"
                        onClick={() => {
                          const next = selected
                            ? digest.digestFeedIds.filter((id: string) => id !== feed.id)
                            : [...digest.digestFeedIds, feed.id];
                          update({ digestFeedIds: next });
                        }}
                        title={feed.name}
                        className={cn(
                          "inline-flex max-w-[14rem] items-center gap-1.5 rounded-xl px-3 py-1 text-xs font-medium transition-all",
                          selected
                            ? "bg-accent text-accent-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                        )}
                      >
                        {feed.icon && <span className="shrink-0">{feed.icon}</span>}
                        <span className="truncate">{feed.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Label filter */}
            {labels.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t("digest.labelFilter")}{" "}
                  <span className="normal-case font-normal">({t("digest.labelFilterHint")})</span>
                </label>
                <div className="flex flex-wrap gap-2 rounded-2xl border border-border/70 bg-background/50 p-3 min-h-[48px]">
                  {labels.map((label: any) => {
                    const selected = digest.digestLabelIds.includes(label.id);
                    return (
                      <button
                        key={label.id}
                        type="button"
                        onClick={() => {
                          const next = selected
                            ? digest.digestLabelIds.filter((id: string) => id !== label.id)
                            : [...digest.digestLabelIds, label.id];
                          update({ digestLabelIds: next });
                        }}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-xl px-3 py-1 text-xs font-medium transition-all",
                          selected
                            ? "bg-accent text-accent-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                        )}
                      >
                        <span
                          className="h-2 w-2 rounded-full shrink-0"
                          style={{ background: label.color }}
                        />
                        {label.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Skip already-featured articles */}
            <div className="flex items-start justify-between rounded-2xl border border-border/70 bg-background/50 p-4">
              <div className="pr-3">
                <p className="text-sm font-medium">{t("digest.skipFeatured")}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t("digest.skipFeaturedHint")}</p>
              </div>
              <button
                role="switch"
                aria-checked={digest.digestSkipFeatured}
                onClick={() => update({ digestSkipFeatured: !digest.digestSkipFeatured })}
                className={cn(
                  "relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                  digest.digestSkipFeatured ? "bg-primary" : "bg-muted",
                )}
              >
                <span
                  className={cn(
                    "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200",
                    digest.digestSkipFeatured ? "translate-x-5" : "translate-x-0",
                  )}
                />
              </button>
            </div>

            {/* Pause */}
            <div className="rounded-2xl border border-border/70 bg-background/50 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">{isPaused ? `${t("digest.pauseUntil")}: ${format.dateTime(new Date(digest.digestPausedUntil!), { dateStyle: "medium" })}` : t("digest.pauseDigest")}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t("digest.pauseDigestHint")}</p>
                </div>
                {isPaused ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-xl shrink-0"
                    onClick={() => update({ digestPausedUntil: null })}
                  >
                    {t("digest.resumeDigest")}
                  </Button>
                ) : (
                  <Select onValueChange={(v) => {
                    const map: Record<string, number | null> = { tomorrow: 1, "3days": 3, "1week": 7, "2weeks": 14, indefinite: null };
                    pauseUntil(map[v] ?? 7);
                  }}>
                    <SelectTrigger className="rounded-xl border-border/70 bg-background/70 h-9 w-auto min-w-[130px] shrink-0">
                      <SelectValue placeholder={t("digest.pauseDigest")} />
                    </SelectTrigger>
                    <SelectContent className="rounded-xl">
                      <SelectItem value="tomorrow">{t("digest.pauseOptions.tomorrow")}</SelectItem>
                      <SelectItem value="3days">{t("digest.pauseOptions.3days")}</SelectItem>
                      <SelectItem value="1week">{t("digest.pauseOptions.1week")}</SelectItem>
                      <SelectItem value="2weeks">{t("digest.pauseOptions.2weeks")}</SelectItem>
                      <SelectItem value="indefinite">{t("digest.pauseOptions.indefinite")}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            {/* Preview + Send test */}
            <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-start">
              <Button
                variant="outline"
                onClick={() => preview.mutate()}
                disabled={preview.isPending}
                className="rounded-2xl h-10"
              >
                <Mail className="w-4 h-4 me-2" />
                {preview.isPending ? t("digest.previewing") : t("digest.preview")}
              </Button>
              <Button
                variant="outline"
                onClick={() => sendTest.mutate()}
                disabled={sendTest.isPending}
                className="rounded-2xl h-10"
              >
                <Send className="w-4 h-4 me-2" />
                {sendTest.isPending ? t("digest.sending") : t("digest.sendTestDigest")}
              </Button>
              <div className="flex flex-col gap-0.5 justify-center">
                {preview.data && (
                  <p className={cn("text-sm font-medium", preview.data.wouldSend ? "text-foreground" : "text-destructive")}>
                    {preview.data.articleCount === 0
                      ? t("digest.previewEmpty")
                      : !preview.data.wouldSend
                        ? t("digest.previewWouldSkip")
                        : `${t("digest.previewResult", { count: preview.data.articleCount })} ${t("digest.previewFeeds", { count: preview.data.feedBreakdown.length })}`
                    }
                  </p>
                )}
                {!preview.data && (
                  <p className="text-xs text-muted-foreground">{t("digest.testDigestHint")}</p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function DeleteAccountSection() {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const handleDelete = async () => {
    setLoading(true);
    try {
      const result = await deleteOwnAccount();
      if ("error" in result) {
        toast.error(result.error);
        setLoading(false);
        return;
      }
      toast.success(t("deleteAccount.accountDeleted"));
      await signOut({ callbackUrl: "/login" });
    } catch {
      toast.error(t("deleteAccount.deletionFailed"));
      setLoading(false);
    }
  };

  return (
    <>
      <section className="rounded-[2rem] border border-destructive/25 bg-destructive/5 p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-[-0.02em]">{t("deleteAccount.title")}</h2>
              <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                {t("deleteAccount.description")}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => setOpen(true)}
            className="h-11 rounded-2xl border-destructive/40 text-destructive hover:bg-destructive/10 px-5 shrink-0"
          >
            <Trash2 className="me-2 h-4 w-4" />
            {t("deleteAccount.deleteMyAccount")}
          </Button>
        </div>
      </section>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="rounded-3xl border-border/70 bg-background">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              {t("deleteAccount.confirmDialogTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span className="block">
                {t("deleteAccount.confirmDialogDescription")}
                <strong> {t("deleteAccount.cannotBeUndone")}</strong>
              </span>
              <span className="block mt-3 text-sm font-medium text-foreground">
                {t("deleteAccount.typeToConfirm")}
              </span>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={t("deleteAccount.confirmPlaceholder")}
                className="rounded-2xl border-border/70 bg-background/70"
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-2xl" onClick={() => setConfirmText("")}>
              {t("deleteAccount.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="rounded-2xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
              disabled={confirmText !== "delete my account" || loading}
            >
              {loading ? t("deleteAccount.deleting") : t("deleteAccount.deletePermanently")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ApiTokenSection() {
  const t = useTranslations();
  const format = useFormatter();
  const [tokens, setTokens] = useState<Array<{
    id: string; name: string; scope: string; expiresAt: string | null; lastUsedAt: string | null; createdAt: string;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [newRawToken, setNewRawToken] = useState<string | null>(null);
  const [newTokenId, setNewTokenId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState(t("apiTokens.defaultTokenName"));
  const [createScope, setCreateScope] = useState("write");
  const [createExpiry, setCreateExpiry] = useState("never");
  const [creating, setCreating] = useState(false);

  const loadTokens = useCallback(async () => {
    const res = await fetch("/api/user/tokens");
    if (res.ok) {
      const data = await res.json();
      setTokens(data.tokens ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void loadTokens(); }, [loadTokens]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const expiresAt = createExpiry === "never" ? null
        : new Date(Date.now() + ({ "30d": 30, "90d": 90, "1y": 365 } as Record<string, number>)[createExpiry]! * 86400_000).toISOString();
      const res = await fetch("/api/user/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createName, scope: createScope, expiresAt }),
      });
      if (res.ok) {
        const data = await res.json();
        setNewRawToken(data.token);
        setNewTokenId(data.id);
        setShowCreate(false);
        setCreateName(t("apiTokens.defaultTokenName"));
        setCreateScope("write");
        setCreateExpiry("never");
        await loadTokens();
        toast.success(t("apiTokens.toasts.created"));
      } else {
        toast.error(t("apiTokens.toasts.failedCreate"));
      }
    } finally {
      setCreating(false);
    }
  }, [createName, createScope, createExpiry, loadTokens, t]);

  const handleRevoke = useCallback(async (id: string, name: string) => {
    const res = await fetch(`/api/user/tokens/${id}`, { method: "DELETE" });
    if (res.ok) {
      if (newTokenId === id) { setNewRawToken(null); setNewTokenId(null); }
      await loadTokens();
      toast.success(t("apiTokens.toasts.revoked", { name }));
    }
  }, [loadTokens, newTokenId, t]);

  const handleCopy = useCallback(() => {
    if (newRawToken) {
      navigator.clipboard.writeText(newRawToken);
      toast.success(t("apiTokens.toasts.copied"));
    }
  }, [newRawToken, t]);

  const scopeLabel = (scope: string) => ({ read: t("apiTokens.scopes.read"), write: t("apiTokens.scopes.readWrite"), admin: t("apiTokens.scopes.admin") } as Record<string, string>)[scope] ?? scope;
  const scopeColor = (scope: string): "secondary" | "default" | "destructive" =>
    scope === "read" ? "secondary" : scope === "admin" ? "destructive" : "default";

  return (
    <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
      <div className="flex items-start gap-4 mb-5">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Key className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold tracking-[-0.02em]">{t("apiTokens.title")}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {t("apiTokens.description")}
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)} className="rounded-2xl h-9 shrink-0">
          <Plus className="w-4 h-4 me-1" />
          {t("apiTokens.addToken")}
        </Button>
      </div>

      {newRawToken && (
        <div className="mb-4 rounded-2xl bg-accent/5 border border-accent/20 p-4">
          <p className="text-xs font-semibold text-accent mb-2 uppercase tracking-wider">
            {t("apiTokens.newTokenWarning")}
          </p>
          <div className="flex items-center gap-2">
            <Input readOnly value={newRawToken} className="font-mono text-xs h-9 bg-background/60" />
            <Button size="sm" variant="outline" onClick={handleCopy} className="shrink-0 h-9 rounded-xl">
              <Copy className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {showCreate && (
        <div className="mb-4 rounded-2xl border border-border/50 bg-muted/30 p-4 space-y-3">
          <p className="text-sm font-medium">{t("apiTokens.createNewToken")}</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-1">
              <label htmlFor="token-name" className="text-xs text-muted-foreground mb-1 block">{t("apiTokens.name")}</label>
              <Input id="token-name" value={createName} onChange={(e) => setCreateName(e.target.value)} className="h-9 rounded-xl" maxLength={80} />
            </div>
            <div>
              <label htmlFor="token-scope" className="text-xs text-muted-foreground mb-1 block">{t("apiTokens.scope")}</label>
              <Select value={createScope} onValueChange={setCreateScope}>
                <SelectTrigger id="token-scope" className="h-9 rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">{t("apiTokens.scopes.read")}</SelectItem>
                  <SelectItem value="write">{t("apiTokens.scopes.readWrite")}</SelectItem>
                  <SelectItem value="admin">{t("apiTokens.scopes.admin")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label htmlFor="token-expiry" className="text-xs text-muted-foreground mb-1 block">{t("apiTokens.expires")}</label>
              <Select value={createExpiry} onValueChange={setCreateExpiry}>
                <SelectTrigger id="token-expiry" className="h-9 rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">{t("apiTokens.expiry.never")}</SelectItem>
                  <SelectItem value="30d">{t("apiTokens.expiry.d30")}</SelectItem>
                  <SelectItem value="90d">{t("apiTokens.expiry.d90")}</SelectItem>
                  <SelectItem value="1y">{t("apiTokens.expiry.y1")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={handleCreate} disabled={creating || !createName.trim()} className="rounded-xl h-9">
              {creating ? t("apiTokens.creating") : t("apiTokens.create")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)} className="rounded-xl h-9">{t("apiTokens.cancel")}</Button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">{t("apiTokens.loading")}</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("apiTokens.noTokens")}</p>
      ) : (
        <div className="space-y-2">
          {tokens.map((tok) => (
            <div key={tok.id} className="flex items-center gap-3 rounded-xl border border-border/40 bg-background/40 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate">{tok.name}</span>
                  <Badge variant={scopeColor(tok.scope)} className="text-[10px] h-4 px-1.5">{scopeLabel(tok.scope)}</Badge>
                  {tok.expiresAt && <span className="text-[11px] text-muted-foreground">{t("apiTokens.expires")} {format.dateTime(new Date(tok.expiresAt), { dateStyle: "medium" })}</span>}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {t("apiTokens.created")} {format.dateTime(new Date(tok.createdAt), { dateStyle: "medium" })}
                  {tok.lastUsedAt ? ` · ${t("apiTokens.lastUsed")} ${format.dateTime(new Date(tok.lastUsedAt), { dateStyle: "medium" })}` : ` · ${t("apiTokens.neverUsed")}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                onClick={() => handleRevoke(tok.id, tok.name)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Pass the token as <code className="bg-muted px-1 py-0.5 rounded text-[11px]">Authorization: Bearer &lt;token&gt;</code>.{" "}
        The Fever API uses <code className="bg-muted px-1 py-0.5 rounded text-[11px]">md5(email:token)</code> as its api_key.
      </p>
    </section>
  );
}

function AiSummarySection() {
  const t = useTranslations();
  const { data: ai } = useAiSettings();
  const updateAi = useUpdateAiSettings();
  const testAi = useTestAiConnection();
  const [provider, setProvider] = useState<string>("none");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("");
  const [language, setLanguage] = useState("same");
  const [autoSummarize, setAutoSummarize] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  useEffect(() => {
    if (!ai) return;
    setProvider(ai.provider ?? "none");
    setModel(ai.model ?? "");
    setOllamaBaseUrl(ai.ollamaBaseUrl ?? "");
    setLanguage(ai.language ?? "same");
    setAutoSummarize(ai.autoSummarize ?? false);
  }, [ai]);

  const handleSave = () => {
    setTestResult(null);
    updateAi.mutate({
      provider: provider === "none" ? null : provider,
      ...(apiKey ? { apiKey } : {}),
      model: model || null,
      ollamaBaseUrl: ollamaBaseUrl || null,
      autoSummarize,
      language,
    });
  };

  const handleTest = async () => {
    setTestResult(null);
    const result = await testAi.mutateAsync();
    setTestResult(result);
  };

  return (
    <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
      <div className="flex items-start gap-4 mb-6">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.02em]">{t("ai.title")}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {t("ai.description")}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Provider */}
        <div className="grid gap-1.5">
          <label className="text-sm font-medium" htmlFor="ai-provider-select">{t("ai.provider")}</label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger id="ai-provider-select" className="h-10 rounded-xl">
              <SelectValue placeholder={t("ai.provider")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("ai.providers.none")}</SelectItem>
              <SelectItem value="openai">{t("ai.providers.openai")}</SelectItem>
              <SelectItem value="anthropic">{t("ai.providers.anthropic")}</SelectItem>
              <SelectItem value="gemini">{t("ai.providers.gemini")}</SelectItem>
              <SelectItem value="openrouter">{t("ai.providers.openrouter")}</SelectItem>
              <SelectItem value="ollama">{t("ai.providers.ollama")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {provider !== "none" && provider !== "ollama" && (
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="ai-api-key-input">
              {t("ai.apiKey")}
              {ai?.hasApiKey && !apiKey && (
                <span className="ms-2 text-xs font-normal text-muted-foreground">({t("ai.currentlySet")})</span>
              )}
            </label>
            <Input
              id="ai-api-key-input"
              type="password"
              placeholder={ai?.hasApiKey ? t("ai.leaveBlankToKeep") : "sk-..."}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-10 rounded-xl font-mono text-sm"
            />
          </div>
        )}

        {provider === "ollama" && (
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="ai-ollama-base-url-input">{t("ai.ollamaBaseUrl")}</label>
            <Input
              id="ai-ollama-base-url-input"
              placeholder="http://localhost:11434"
              value={ollamaBaseUrl}
              onChange={(e) => setOllamaBaseUrl(e.target.value)}
              className="h-10 rounded-xl font-mono text-sm"
            />
          </div>
        )}

        {provider !== "none" && (
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="ai-model-input">
              {t("ai.model")}
              <span className="ms-1 text-xs font-normal text-muted-foreground">
                {provider === "openai" && "(default: gpt-4o-mini)"}
                {provider === "anthropic" && "(default: claude-haiku-4-5-20251001)"}
                {provider === "gemini" && "(default: gemini-1.5-flash)"}
                {provider === "openrouter" && "(default: openai/gpt-4o-mini)"}
                {provider === "ollama" && "(default: llama3)"}
              </span>
            </label>
            <Input
              id="ai-model-input"
              placeholder="optional override"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="h-10 rounded-xl font-mono text-sm"
            />
          </div>
        )}

        {provider !== "none" && (
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="ai-language-select">{t("ai.summaryLanguage")}</label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger id="ai-language-select" className="h-10 rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="same">{t("ai.languages.same")}</SelectItem>
                <SelectItem value="English">{t("ai.languages.english")}</SelectItem>
                <SelectItem value="German">{t("ai.languages.german")}</SelectItem>
                <SelectItem value="French">{t("ai.languages.french")}</SelectItem>
                <SelectItem value="Spanish">{t("ai.languages.spanish")}</SelectItem>
                <SelectItem value="Japanese">{t("ai.languages.japanese")}</SelectItem>
                <SelectItem value="Chinese">{t("ai.languages.chinese")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {provider !== "none" && (
          <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/30 px-4 py-3">
            <div>
              <p className="text-sm font-medium">{t("ai.autoSummarize")}</p>
              <p className="text-xs text-muted-foreground">{t("ai.autoSummarizeDescription")}</p>
            </div>
            <Switch
              checked={autoSummarize}
              onCheckedChange={setAutoSummarize}
              className="h-7 w-12"
            />
          </div>
        )}

        {testResult && (
          <div className={cn(
            "flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm",
            testResult.success
              ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          )}>
            {testResult.success
              ? <CheckCircle2 className="h-4 w-4 shrink-0" />
              : <XCircle className="h-4 w-4 shrink-0" />}
            <span>{testResult.success ? t("ai.connectionSuccessful") : testResult.error}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button
            onClick={handleSave}
            disabled={updateAi.isPending}
            className="rounded-2xl h-10"
          >
            {updateAi.isPending ? t("ai.saving") : t("ai.save")}
          </Button>
          {provider !== "none" && (
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testAi.isPending}
              className="rounded-2xl h-10"
            >
              <Sparkles className="w-4 h-4 me-2" />
              {testAi.isPending ? t("ai.testing") : t("ai.testConnection")}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

type SyncClient = {
  name: string;
  platforms: string;
  url: string;
  api: "greader" | "opml";
  serverField: string;
  notesKey?: string;
};

const SYNC_CLIENTS: SyncClient[] = [
  {
    name: "Reeder 5 / Classic",
    platforms: "macOS, iOS, iPadOS",
    url: "https://reederapp.com/",
    api: "greader",
    serverField: "FreshRSS / FeedHQ",
    notesKey: "syncReaders.clients.reeder5.notes",
  },
  {
    name: "NetNewsWire",
    platforms: "macOS, iOS",
    url: "https://netnewswire.com/",
    api: "greader",
    serverField: "FreshRSS",
    notesKey: "syncReaders.clients.netnewswire.notes",
  },
  {
    name: "ReadKit",
    platforms: "macOS, iOS",
    url: "https://readkit.app/",
    api: "greader",
    serverField: "Fever / FreshRSS",
    notesKey: "syncReaders.clients.readkit.notes",
  },
  {
    name: "Fluent Reader",
    platforms: "Windows, macOS, Linux",
    url: "https://hyliu.me/fluent-reader/",
    api: "greader",
    serverField: "FreshRSS",
    notesKey: "syncReaders.clients.fluentreader.notes",
  },
  {
    name: "FeedMe",
    platforms: "Android",
    url: "https://play.google.com/store/apps/details?id=com.seazon.feedme",
    api: "greader",
    serverField: "Custom Google Reader API",
    notesKey: "syncReaders.clients.feedme.notes",
  },
  {
    name: "News+",
    platforms: "Android",
    url: "https://noinnion.com/newsplus/",
    api: "greader",
    serverField: "GReader compatible",
    notesKey: "syncReaders.clients.newsplus.notes",
  },
  {
    name: "Feedly",
    platforms: "Web, iOS, Android",
    url: "https://feedly.com/",
    api: "opml",
    serverField: "OPML import / export",
    notesKey: "syncReaders.clients.feedly.notes",
  },
  {
    name: "Inoreader",
    platforms: "Web, iOS, Android",
    url: "https://www.inoreader.com/",
    api: "opml",
    serverField: "OPML import / export",
    notesKey: "syncReaders.clients.inoreader.notes",
  },
];

function SyncTutorialSection() {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [instanceUrl, setInstanceUrl] = useState<string>("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    setInstanceUrl(window.location.origin);
  }, []);

  const greaderUrl = `${instanceUrl || "https://your-feedferret"}/api/greader`;
  const apiUrl = `${instanceUrl || "https://your-feedferret"}/api/v1`;

  return (
    <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-4 text-start"
      >
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Rss className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold tracking-[-0.02em]">{t("syncReaders.title")}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {t("syncReaders.description")}
          </p>
        </div>
        <span className="mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
      </button>

      {open && (
        <div className="mt-6 space-y-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-border/60 bg-background/60 p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("syncReaders.greaderEndpoint")}</p>
              <p className="mt-1 break-all text-sm font-mono">{greaderUrl}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {t("syncReaders.greaderUsernameHint")}
              </p>
            </div>
            <div className="rounded-2xl border border-border/60 bg-background/60 p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("syncReaders.restApiBase")}</p>
              <p className="mt-1 break-all text-sm font-mono">{apiUrl}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {t("syncReaders.restApiHint")}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {SYNC_CLIENTS.map((client) => (
              <div
                key={client.name}
                className="rounded-2xl border border-border/60 bg-background/60 p-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold">{client.name}</p>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {client.platforms}
                      </span>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-medium",
                          client.api === "greader"
                            ? "bg-emerald-500/10 text-emerald-500"
                            : "bg-amber-500/10 text-amber-600",
                        )}
                      >
                        {client.api === "greader" ? t("syncReaders.directSync") : t("syncReaders.opmlOnly")}
                      </span>
                    </div>
                    {client.notesKey && (
                      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{t(client.notesKey as any)}</p>
                    )}
                  </div>
                  <a
                    href={client.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-border/60 bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted/60 transition-colors"
                  >
                    {t("syncReaders.openSite")}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                {client.api === "greader" && (
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    {t("syncReaders.inClientChoose")} <strong>{client.serverField}</strong> and paste <code className="rounded bg-background/80 px-1 font-mono">{greaderUrl}</code> {t("syncReaders.serverUrl")}
                  </p>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs text-muted-foreground leading-relaxed">
            <p className="font-medium text-amber-600 dark:text-amber-400 mb-1">{t("syncReaders.twoFactorNote")}</p>
            <p>
              {t("syncReaders.twoFactorNoteBody")}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function NotificationChannelsSection() {
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
    <section className="rounded-[2rem] border border-border/65 bg-card/85 shadow-sm backdrop-blur-2xl">
      <div className="flex items-start gap-4 p-5 sm:p-6">
        <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
          <Bell className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold tracking-[-0.02em]">{t("notifications.title")}</h2>
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
              <Input
                placeholder={t("notifications.botTokenPlaceholder")}
                {...field("telegramBotToken")}
                className="h-9 font-mono text-xs"
              />
              <Input
                placeholder={t("notifications.chatIdPlaceholder")}
                {...field("telegramChatId")}
                className="h-9 font-mono text-xs"
              />
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
              <Input
                placeholder={t("notifications.serverUrlPlaceholder")}
                {...field("gotifyUrl")}
                className="h-9 font-mono text-xs"
              />
              <Input
                placeholder={t("notifications.appToken")}
                {...field("gotifyToken")}
                className="h-9 font-mono text-xs"
              />
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
              <Input
                placeholder={t("notifications.topicUrlPlaceholder")}
                {...field("ntfyUrl")}
                className="h-9 font-mono text-xs"
              />
              <Input
                placeholder={t("notifications.tokenOptionalPlaceholder")}
                {...field("ntfyToken")}
                className="h-9 font-mono text-xs"
              />
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
