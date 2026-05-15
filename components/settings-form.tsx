"use client";

import { useSession, signOut } from "next-auth/react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import {
  AlignLeft,
  ArrowDownAZ,
  ArrowLeft,
  Clock,
  Copy,
  ExternalLink,
  Key,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useReadingPreferences, useUpdateGlobalSettings, useDigestSettings, useUpdateDigestSettings, useSendTestDigest, useFeeds, useTwoFactorStatus, useBeginTwoFactorSetup, useConfirmTwoFactorSetup, useDisableTwoFactor, useAiSettings, useUpdateAiSettings, useTestAiConnection } from "@/hooks/use-rss-data";
import { useInstance } from "@/hooks/use-instance";
import { WebhookSection } from "@/components/webhook-management";
import { useState, useCallback, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { MobileFloatingBackButton } from "@/components/mobile-floating-back-button";
import { toast } from "sonner";
import { SHOW_PWA_INSTALL_PROMPT_EVENT } from "@/components/pwa-install-prompt";

const themeOptions = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Laptop },
];

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
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const { data: prefs } = useReadingPreferences();
  const updateSettings = useUpdateGlobalSettings();

  const update = (data: Parameters<typeof updateSettings.mutate>[0]) =>
    updateSettings.mutate(data);

  return (
    <main className="min-h-dvh app-chrome text-foreground overflow-x-hidden">
      <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 py-6 pb-24 sm:px-6 lg:px-8 lg:pb-6">
        <header className="mb-8 flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.back()}
            className="h-11 w-11 rounded-2xl bg-card/70 backdrop-blur-xl border border-border/60 shadow-sm"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Settings className="h-4 w-4" />
              FeedFerret
            </div>
            <h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              Settings
            </h1>
          </div>
        </header>

        <div className="grid gap-5">
          {/* ── Appearance & Interface ── */}

          {/* Theme */}
          <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-4">
                <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
                  <Palette className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-[-0.02em]">Appearance</h2>
                  <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                    Choose the visual mode.
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
            title="Accent colors"
            description="Primary and secondary accent colors used for highlights and indicators."
          >
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm text-muted-foreground">Primary</label>
                <input
                  type="color"
                  value={prefs?.accentColor ?? "#5BA4CF"}
                  onChange={(e) => update({ accentColor: e.target.value })}
                  className="w-10 h-10 rounded-xl border border-border/70 cursor-pointer bg-transparent p-0.5"
                  title="Primary accent color"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm text-muted-foreground">Secondary</label>
                <input
                  type="color"
                  value={prefs?.secondaryColor ?? "#F0963C"}
                  onChange={(e) => update({ secondaryColor: e.target.value })}
                  className="w-10 h-10 rounded-xl border border-border/70 cursor-pointer bg-transparent p-0.5"
                  title="Secondary accent color"
                />
              </div>
              <button
                type="button"
                onClick={() => update({ accentColor: "#5BA4CF", secondaryColor: "#F0963C" })}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Reset
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
                      Preview
                    </p>
                    <p className="text-sm font-medium">App accents</p>
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
            title="Default view"
            description="Article list layout shown by default when opening the app."
          >
            <Select
              value={normalizeDefaultViewMode(prefs?.defaultViewMode)}
              onValueChange={(v) => update({ defaultViewMode: v })}
            >
              <SelectTrigger className="h-10 w-full rounded-2xl border-border/70 bg-background/70 sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-2xl">
                <SelectItem value="list">List</SelectItem>
                <SelectItem value="magazine">Magazine</SelectItem>
                <SelectItem value="minimal">Minimal</SelectItem>
              </SelectContent>
            </Select>
          </PrefRow>

          {/* Reader width */}
          <PrefRow
            icon={AlignLeft}
            title="Reader width"
            description="Maximum width of article content in the reader pane."
          >
            <Select
              value={prefs?.readerWidth ?? "normal"}
              onValueChange={(v) => update({ readerWidth: v })}
            >
              <SelectTrigger className="h-10 w-full rounded-2xl border-border/70 bg-background/70 sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-2xl">
                <SelectItem value="normal">Normal (768px)</SelectItem>
                <SelectItem value="wide">Wide (1024px)</SelectItem>
                <SelectItem value="full">Full width</SelectItem>
              </SelectContent>
            </Select>
          </PrefRow>

          {/* ── Reading Behaviour ── */}

          {/* Default sort order */}
          <PrefRow
            icon={ArrowDownAZ}
            title="Default sort"
            description="Default article sort order in all feeds and categories."
          >
            <Select
              value={prefs?.defaultArticleSort ?? "newest"}
              onValueChange={(v) => update({ defaultArticleSort: v })}
            >
              <SelectTrigger className="h-10 w-full rounded-2xl border-border/70 bg-background/70 sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-2xl">
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
              </SelectContent>
            </Select>
          </PrefRow>

          {/* Mark-as-read delay */}
          <PrefRow
            icon={Clock}
            title="Mark as read"
            description="How long after opening an article it gets marked as read. 'Off' disables auto-mark."
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
                <SelectItem value="instant">Instant (1s)</SelectItem>
                <SelectItem value="5">After 5s</SelectItem>
                <SelectItem value="15">After 15s</SelectItem>
                <SelectItem value="30">After 30s</SelectItem>
                <SelectItem value="60">After 60s</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
          </PrefRow>

          {/* Mark as read on scroll */}
          <PrefRow
            icon={ScrollText}
            title="Mark as read while scrolling"
            description="Articles are automatically marked as read once they scroll out of view."
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
            title="Open original"
            description="Open original article in new tab when selecting from list."
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
            title="Hide duplicates"
            description="When the same article appears in multiple feeds, show it only once (from the first feed that synced it)."
          >
            <Switch
              checked={prefs?.hideDuplicates ?? true}
              onCheckedChange={(checked) => update({ hideDuplicates: checked })}
              className="h-7 w-12"
            />
          </PrefRow>

          {/* ── Account & Security ── */}

          {/* User Profile */}
          <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <User className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-[-0.02em]">User Profile</h2>
                  <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                    Signed in as{" "}
                    <span className="font-medium text-foreground">
                      {session?.user?.email || "Unknown user"}
                    </span>
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                onClick={() => signOut({ callbackUrl: "/" })}
                className="h-11 rounded-2xl border-border/70 bg-background/70 px-5"
              >
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </Button>
            </div>
          </section>

          {/* Two-factor authentication */}
          <TwoFactorSection />

          {/* API Access */}
          <ApiTokenSection />

          {/* ── Integrations & Notifications ── */}

          {/* Browser notifications – hidden when server not configured (#13) */}
          <PushNotificationSection />

          {/* Digest Email – hidden when mail not configured (#13, handled inside) */}
          <DigestSection />

          {/* AI Summaries */}
          <AiSummarySection />

          {/* Outbound Webhooks */}
          <WebhookSection />

          {/* ── Device & Misc ── */}

          {/* Add to Home Screen */}
          <PrefRow
            icon={Smartphone}
            title="Add to Home Screen"
            description="Show instructions for installing FeedFerret as a PWA on your phone or tablet."
          >
            <Button
              type="button"
              variant="outline"
              onClick={() => window.dispatchEvent(new Event(SHOW_PWA_INSTALL_PROMPT_EVENT))}
              className="h-11 rounded-2xl border-border/70 bg-background/70 px-5"
            >
              Show instructions
            </Button>
          </PrefRow>

          <PrefRow
            icon={Keyboard}
            title="Keyboard shortcuts"
            description="Desktop keyboard shortcuts for fast navigation without a mouse."
          >
            <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground sm:min-w-80">
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <span className="font-mono text-foreground">j / k</span>
                <span>Next / previous article</span>
                <span className="font-mono text-foreground">n / p</span>
                <span>Next / previous unread article</span>
                <span className="font-mono text-foreground">m / s</span>
                <span>Toggle read / star</span>
                <span className="font-mono text-foreground">/</span>
                <span>Open search</span>
                <span className="font-mono text-foreground">?</span>
                <span>Open shortcut help</span>
              </div>
            </div>
          </PrefRow>

          {/* ── Danger Zone ── */}

          {/* GDPR Account Deletion */}
          <DeleteAccountSection />
        </div>
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
        toast.error("Could not save notification settings");
        await loadStatus();
      }
    },
    [loadStatus, status?.settings],
  );

  const enable = useCallback(async () => {
    if (!supported || !status?.publicKey) return;
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast.error("Notification permission was not granted");
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
      toast.success("Browser notifications enabled");
      await loadStatus();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not enable notifications");
    } finally {
      setBusy(false);
    }
  }, [loadStatus, status, supported]);

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
      toast.success("Notifications disabled for this device");
      await loadStatus();
    } finally {
      setBusy(false);
    }
  }, [loadStatus]);

  const sendTest = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      toast.success("Test notification sent");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send test notification");
    } finally {
      setBusy(false);
    }
  }, []);

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
              <h2 className="text-lg font-semibold tracking-[-0.02em]">Browser notifications</h2>
              <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                Get notified when new articles arrive. Titles are included in notifications.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Status: {loading ? "checking…" : !supported ? "unsupported" : !status?.configured ? "server not configured" : permission}
                {status ? ` · ${status.activeSubscriptions} active device${status.activeSubscriptions === 1 ? "" : "s"}` : ""}
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
                Enable
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={sendTest} disabled={busy} className="h-11 rounded-2xl px-5">
                  Test
                </Button>
                <Button type="button" variant="outline" onClick={disable} disabled={busy} className="h-11 rounded-2xl px-5">
                  Disable device
                </Button>
              </>
            )}
          </div>
        </div>

        {status && (
          <div className="grid gap-4 rounded-[1.5rem] border border-border/70 bg-background/60 p-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Frequency</label>
              <Select
                value={status.settings.pushFrequency}
                onValueChange={(value) => updateSettings({ pushFrequency: value })}
              >
                <SelectTrigger className="rounded-2xl border-border/70 bg-background/70">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-2xl">
                  <SelectItem value="immediate">Immediately</SelectItem>
                  <SelectItem value="hourly">Hourly summary</SelectItem>
                  <SelectItem value="daily">Daily summary</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/20 px-4 py-3">
              <div>
                <p className="text-sm font-medium">Include article titles</p>
                <p className="text-xs text-muted-foreground">Disable for generic private notifications.</p>
              </div>
              <Switch
                checked={status.settings.pushPrivatePayloads}
                onCheckedChange={(checked) => updateSettings({ pushPrivatePayloads: checked })}
              />
            </div>
            <div className="sm:col-span-2">
              <p className="mb-2 text-sm font-medium">Feeds</p>
              <div className="max-h-44 overflow-y-auto rounded-2xl border border-border/70 bg-background/70 p-3">
                <label className="mb-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={feedIds.size === 0}
                    onChange={() => updateSettings({ pushFeedIds: [] })}
                  />
                  All feeds
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
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Could not copy ${label.toLowerCase()}`);
    }
  }, []);

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
              <h2 className="text-lg font-semibold tracking-[-0.02em]">Two-factor authentication</h2>
              <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                Protect your email/password login with a 6-digit authenticator code. OAuth providers like Authelia can enforce MFA separately.
              </p>
            </div>
          </div>
          {status?.enabled ? (
            <div className="inline-flex items-center gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              <Shield className="h-4 w-4" /> Enabled
            </div>
          ) : (
            <Button
              type="button"
              onClick={handleBegin}
              disabled={beginSetup.isPending}
              className="h-11 rounded-2xl px-5"
            >
              {beginSetup.isPending ? "Starting…" : "Set up 2FA"}
            </Button>
          )}
        </div>

        {setupData && !status?.enabled && (
          <div className="grid gap-4 rounded-[1.5rem] border border-border/70 bg-background/60 p-4 sm:p-5">
            <div className="grid gap-2">
              <p className="text-sm font-medium">1. Add this account in your authenticator app</p>
              <p className="text-xs text-muted-foreground">
                Use manual setup if your app does not support opening otpauth links directly.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-border/70 bg-background/70 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Account</p>
                <p className="mt-1 text-sm font-medium break-all">{setupData.accountName}</p>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/70 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Secret</p>
                <div className="mt-1 flex items-center gap-2">
                  <p className="text-sm font-medium break-all">{setupData.secret}</p>
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8 rounded-xl" onClick={() => copyValue(setupData.secret, "Secret")}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">otpauth URI</p>
                  <p className="mt-1 text-xs text-muted-foreground break-all">{setupData.uri}</p>
                </div>
                <Button type="button" variant="outline" className="rounded-2xl" onClick={() => copyValue(setupData.uri, "URI")}>
                  <Copy className="mr-2 h-4 w-4" /> Copy
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="space-y-2">
                <label className="text-sm font-medium">2. Enter the current 6-digit code</label>
                <Input
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
                  Cancel
                </Button>
                <Button type="button" className="rounded-2xl" onClick={handleEnable} disabled={confirmSetup.isPending || setupCode.length !== 6}>
                  {confirmSetup.isPending ? "Enabling…" : "Enable 2FA"}
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
                Google Reader password login is disabled for accounts with 2FA enabled. For SSO flows like Authelia, MFA should be handled by your identity provider.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="space-y-2">
                <label className="text-sm font-medium">Disable 2FA</label>
                <Input
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="Enter current code"
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
                {disableTwoFactor.isPending ? "Disabling…" : "Disable 2FA"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

const DAYS = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

function DigestSection() {
  const { data: digest } = useDigestSettings();
  const { data: feedsData } = useFeeds();
  const { data: instance, loading: instanceLoading } = useInstance();
  const updateDigest = useUpdateDigestSettings();
  const sendTest = useSendTestDigest();

  if (!digest) return null;
  // Hide entirely if instance has no mail configured (#5)
  if (!instanceLoading && instance && !instance.capabilities.mail) return null;

  const feeds = feedsData ?? [];

  function update(data: Parameters<typeof updateDigest.mutate>[0]) {
    updateDigest.mutate(data);
  }

  return (
    <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
      <div className="flex items-start gap-4 mb-6">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Mail className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.02em]">Email Digest</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Receive a periodic email summary of articles from your feeds.
            Requires SMTP to be configured by your administrator.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        {/* Enable toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Enable digest emails</p>
            {digest.digestLastSentAt && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Last sent: {new Date(digest.digestLastSentAt).toLocaleString()}
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
            {/* Frequency */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Frequency</label>
                <Select
                  value={digest.digestFrequency}
                  onValueChange={(v) => update({ digestFrequency: v })}
                >
                  <SelectTrigger className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Day of week (weekly only) */}
              {digest.digestFrequency === "weekly" && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Day</label>
                  <Select
                    value={String(digest.digestDayOfWeek)}
                    onValueChange={(v) => update({ digestDayOfWeek: parseInt(v) })}
                  >
                    <SelectTrigger className="rounded-2xl border-border/70 bg-background/70 h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="rounded-2xl">
                      {DAYS.map((d) => (
                        <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Hour */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Hour (UTC)</label>
                <Select
                  value={String(digest.digestHour)}
                  onValueChange={(v) => update({ digestHour: parseInt(v) })}
                >
                  <SelectTrigger className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    {Array.from({ length: 24 }, (_, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {String(i).padStart(2, "0")}:00 UTC
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Scope */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Include</label>
                <Select
                  value={digest.digestScope}
                  onValueChange={(v) => update({ digestScope: v })}
                >
                  <SelectTrigger className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    <SelectItem value="unread">Unread</SelectItem>
                    <SelectItem value="all">All new</SelectItem>
                    <SelectItem value="starred">Starred</SelectItem>
                    <SelectItem value="readlater">Read Later</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Feed filter */}
            {feeds.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Feed filter{" "}
                  <span className="normal-case font-normal">(leave empty for all feeds)</span>
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

            {/* Send test */}
            <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center">
              <Button
                variant="outline"
                onClick={() => sendTest.mutate()}
                disabled={sendTest.isPending}
                className="rounded-2xl h-10"
              >
                <Send className="w-4 h-4 mr-2" />
                {sendTest.isPending ? "Sending…" : "Send test digest now"}
              </Button>
              <p className="text-xs text-muted-foreground">
                Sends to your account email using the last 7 days of articles.
              </p>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function DeleteAccountSection() {
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
      toast.success("Account deleted. Goodbye!");
      await signOut({ callbackUrl: "/login" });
    } catch {
      toast.error("Account deletion failed. Try again.");
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
              <h2 className="text-lg font-semibold tracking-[-0.02em]">Delete Account</h2>
              <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                Permanently delete your account and all associated data — feeds, articles, labels, and settings.
                This action is irreversible and complies with GDPR Art. 17 (right to erasure).
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => setOpen(true)}
            className="h-11 rounded-2xl border-destructive/40 text-destructive hover:bg-destructive/10 px-5 shrink-0"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete my account
          </Button>
        </div>
      </section>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="rounded-3xl border-border/70 bg-background">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete your account?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span className="block">
                This will permanently delete your account, all your feeds, articles, labels, and settings.
                <strong> This cannot be undone.</strong>
              </span>
              <span className="block mt-3 text-sm font-medium text-foreground">
                Type <code className="bg-muted px-1.5 py-0.5 rounded text-xs">delete my account</code> to confirm:
              </span>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="delete my account"
                className="rounded-2xl border-border/70 bg-background/70"
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-2xl" onClick={() => setConfirmText("")}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="rounded-2xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
              disabled={confirmText !== "delete my account" || loading}
            >
              {loading ? "Deleting…" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ApiTokenSection() {
  const [token, setToken] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  const checkToken = useCallback(async () => {
    const res = await fetch("/api/user/token");
    if (res.ok) {
      const data = await res.json();
      setHasToken(data.hasToken);
    }
  }, []);

  const generateToken = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/user/token", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setToken(data.token);
        setHasToken(true);
        toast.success("API token generated — save it now, it won't be shown again");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const revokeToken = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/user/token", { method: "DELETE" });
      if (res.ok) {
        setToken(null);
        setHasToken(false);
        toast.success("API token revoked");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const copyToken = useCallback(() => {
    if (token) {
      navigator.clipboard.writeText(token);
      toast.success("Token copied to clipboard");
    }
  }, [token]);

  useEffect(() => {
    void checkToken();
  }, [checkToken]);

  if (hasToken === null) return null;

  return (
    <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
      <div className="flex items-start gap-4 mb-5">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Key className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.02em]">API Access</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Personal API token for browser extensions, mobile apps, and external integrations.
            Each user has one token. Treat it like a password — it grants full read-later access.
          </p>
        </div>
      </div>

      {token && (
        <div className="mb-4 rounded-2xl bg-accent/5 border border-accent/20 p-4">
          <p className="text-xs font-semibold text-accent mb-2 uppercase tracking-wider">
            New token — copy now, won&apos;t be shown again
          </p>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={token}
              className="font-mono text-xs h-9 bg-background/60"
            />
            <Button size="sm" variant="outline" onClick={copyToken} className="shrink-0 h-9 rounded-xl">
              <Copy className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        {!hasToken ? (
          <Button
            onClick={generateToken}
            disabled={loading}
            className="rounded-2xl h-10"
          >
            <Key className="w-4 h-4 mr-2" />
            Generate API token
          </Button>
        ) : (
          <>
            <Button
              onClick={generateToken}
              disabled={loading}
              variant="outline"
              className="rounded-2xl h-10"
            >
              <Key className="w-4 h-4 mr-2" />
              Regenerate token
            </Button>
            <Button
              onClick={revokeToken}
              disabled={loading}
              variant="outline"
              className="rounded-2xl h-10 text-destructive border-destructive/30 hover:bg-destructive/10"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Revoke token
            </Button>
          </>
        )}
        <span className="text-sm text-muted-foreground">
          {hasToken ? "Token is active" : "No token set"}
        </span>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        See <a href="/docs/api" className="underline hover:text-foreground">API documentation</a> for
        usage examples. Pass the token as{" "}
        <code className="bg-muted px-1 py-0.5 rounded text-[11px]">Authorization: Bearer &lt;token&gt;</code>.
      </p>
    </section>
  );
}

function AiSummarySection() {
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
          <h2 className="text-lg font-semibold tracking-[-0.02em]">AI Summaries (BYOK)</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Summarize articles on demand or automatically on sync using your own OpenAI, Anthropic, Gemini, OpenRouter, or Ollama credentials. Your API key is encrypted at rest and never shared.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Provider */}
        <div className="grid gap-1.5">
          <label className="text-sm font-medium">Provider</label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="h-10 rounded-xl">
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None (disabled)</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="anthropic">Anthropic</SelectItem>
              <SelectItem value="gemini">Google Gemini</SelectItem>
              <SelectItem value="openrouter">OpenRouter</SelectItem>
              <SelectItem value="ollama">Ollama (local)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {provider !== "none" && provider !== "ollama" && (
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">
              API Key
              {ai?.hasApiKey && !apiKey && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">(currently set)</span>
              )}
            </label>
            <Input
              type="password"
              placeholder={ai?.hasApiKey ? "Leave blank to keep existing key" : "sk-..."}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-10 rounded-xl font-mono text-sm"
            />
          </div>
        )}

        {provider === "ollama" && (
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Ollama Base URL</label>
            <Input
              placeholder="http://localhost:11434"
              value={ollamaBaseUrl}
              onChange={(e) => setOllamaBaseUrl(e.target.value)}
              className="h-10 rounded-xl font-mono text-sm"
            />
          </div>
        )}

        {provider !== "none" && (
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">
              Model
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {provider === "openai" && "(default: gpt-4o-mini)"}
                {provider === "anthropic" && "(default: claude-haiku-4-5-20251001)"}
                {provider === "gemini" && "(default: gemini-1.5-flash)"}
                {provider === "openrouter" && "(default: openai/gpt-4o-mini)"}
                {provider === "ollama" && "(default: llama3)"}
              </span>
            </label>
            <Input
              placeholder="optional override"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="h-10 rounded-xl font-mono text-sm"
            />
          </div>
        )}

        {provider !== "none" && (
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Summary language</label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="h-10 rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="same">Same as article</SelectItem>
                <SelectItem value="English">English</SelectItem>
                <SelectItem value="German">German</SelectItem>
                <SelectItem value="French">French</SelectItem>
                <SelectItem value="Spanish">Spanish</SelectItem>
                <SelectItem value="Japanese">Japanese</SelectItem>
                <SelectItem value="Chinese">Chinese</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {provider !== "none" && (
          <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/30 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Auto-summarize on sync</p>
              <p className="text-xs text-muted-foreground">Automatically summarize new articles (uses API credits)</p>
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
            <span>{testResult.success ? "Connection successful" : testResult.error}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button
            onClick={handleSave}
            disabled={updateAi.isPending}
            className="rounded-2xl h-10"
          >
            {updateAi.isPending ? "Saving…" : "Save"}
          </Button>
          {provider !== "none" && (
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testAi.isPending}
              className="rounded-2xl h-10"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              {testAi.isPending ? "Testing…" : "Test connection"}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
