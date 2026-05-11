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
  LogOut,
  Mail,
  Moon,
  Palette,
  Send,
  Settings,
  Smartphone,
  Sun,
  Trash2,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useReadingPreferences, useUpdateGlobalSettings, useDigestSettings, useUpdateDigestSettings, useSendTestDigest, useFeeds } from "@/hooks/use-rss-data";
import { useState, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { SHOW_PWA_INSTALL_PROMPT_EVENT } from "@/components/pwa-install-prompt";

const themeOptions = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Laptop },
];

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
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.02em]">{title}</h2>
            <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="shrink-0">{children}</div>
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
    <main className="min-h-dvh app-chrome text-foreground">
      <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 py-6 sm:px-6 lg:px-8">
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
          {/* Appearance */}
          <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
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

          {/* Open original */}
          <PrefRow
            icon={ExternalLink}
            title="Open original"
            description="Open original article in new tab when selecting from list."
          >
            <button
              role="switch"
              aria-checked={prefs?.openOriginalByDefault ?? false}
              onClick={() => update({ openOriginalByDefault: !(prefs?.openOriginalByDefault ?? false) })}
              className={cn(
                "relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                prefs?.openOriginalByDefault ? "bg-primary" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200",
                  prefs?.openOriginalByDefault ? "translate-x-5" : "translate-x-0",
                )}
              />
            </button>
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
              <SelectTrigger className="w-40 rounded-2xl border-border/70 bg-background/70 h-10">
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

          {/* Default view mode */}
          <PrefRow
            icon={AlignLeft}
            title="Default view"
            description="Article list layout shown by default when opening the app."
          >
            <Select
              value={prefs?.defaultViewMode ?? "list"}
              onValueChange={(v) => update({ defaultViewMode: v })}
            >
              <SelectTrigger className="w-40 rounded-2xl border-border/70 bg-background/70 h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-2xl">
                <SelectItem value="list">List</SelectItem>
                <SelectItem value="grid">Grid</SelectItem>
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
              <SelectTrigger className="w-40 rounded-2xl border-border/70 bg-background/70 h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-2xl">
                <SelectItem value="normal">Normal (768px)</SelectItem>
                <SelectItem value="wide">Wide (1024px)</SelectItem>
                <SelectItem value="full">Full width</SelectItem>
              </SelectContent>
            </Select>
          </PrefRow>

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
              <SelectTrigger className="w-40 rounded-2xl border-border/70 bg-background/70 h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-2xl">
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
              </SelectContent>
            </Select>
          </PrefRow>

          {/* Accent colors */}
          <PrefRow
            icon={Palette}
            title="Accent colors"
            description="Primary and secondary accent colors used for highlights and indicators."
          >
            <div className="flex items-center gap-4">
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
            </div>
          </PrefRow>

          {/* API Access */}
          <ApiTokenSection />

          {/* Digest Email */}
          <DigestSection />

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
        </div>
      </div>
    </main>
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
  const updateDigest = useUpdateDigestSettings();
  const sendTest = useSendTestDigest();

  if (!digest) return null;

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
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
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
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-xl px-3 py-1 text-xs font-medium transition-all",
                          selected
                            ? "bg-accent text-accent-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                        )}
                      >
                        {feed.icon && <span>{feed.icon}</span>}
                        {feed.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Send test */}
            <div className="flex items-center gap-3 pt-1">
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

  // Lazy-load status on first render
  if (hasToken === null) {
    checkToken();
    return null;
  }

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
