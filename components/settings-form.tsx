"use client";

import { useSession, signOut } from "next-auth/react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import {
  AlignLeft,
  ArrowDownAZ,
  ArrowLeft,
  Clock,
  ExternalLink,
  Laptop,
  LogOut,
  Moon,
  Palette,
  Settings,
  Sun,
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
import { useReadingPreferences, useUpdateGlobalSettings } from "@/hooks/use-rss-data";

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
