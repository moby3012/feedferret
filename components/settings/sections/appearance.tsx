"use client";

import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { AlignLeft, ALargeSmall, Palette } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useReadingPreferences, useUpdateGlobalSettings } from "@/hooks/use-rss-data";
import { makeThemeOptions, normalizeDefaultViewMode, PrefRow } from "@/components/settings/pref-row";

export function AppearanceSettings() {
  const t = useTranslations();
  const { theme, setTheme } = useTheme();
  const { data: prefs } = useReadingPreferences();
  const updateSettings = useUpdateGlobalSettings();
  const themeOptions = makeThemeOptions(t);
  const update = (data: Parameters<typeof updateSettings.mutate>[0]) => updateSettings.mutate(data);

  return (
    <>
      {/* Theme */}
      <section className="rounded-2xl border border-border/65 bg-card/85 p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
              <Palette className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-title">{t("settings.appearance")}</h2>
              <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                {t("settings.chooseVisualMode")}
              </p>
            </div>
          </div>
          <div className="ui-segmented-surface grid grid-cols-3 gap-1 rounded-2xl border p-1">
            {themeOptions.map((option) => {
              const Icon = option.icon;
              const active = theme === option.id;
              return (
                <button
                  key={option.id}
                  onClick={() => setTheme(option.id)}
                  data-state={active ? "active" : "inactive"}
                  className={cn(
                    "ui-segmented-trigger inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-transparent px-3 text-sm font-medium transition-all",
                    active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
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
              // color-mix (not hex+alpha concatenation) so the "var(--brand)" fallback works too
              background: `linear-gradient(135deg, color-mix(in srgb, ${(prefs?.accentColor ?? "var(--brand)")} 13%, transparent) 0%, color-mix(in srgb, ${(prefs?.secondaryColor ?? "var(--brand-secondary)")} 16%, transparent) 100%)`,
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-overline text-muted-foreground">
                  {t("settings.preview")}
                </p>
                <p className="text-sm font-medium">{t("settings.appAccents")}</p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="h-7 w-7 rounded-full border border-white/40 shadow-sm"
                  style={{ backgroundColor: prefs?.accentColor ?? "var(--brand)" }}
                />
                <span
                  className="h-7 w-7 rounded-full border border-white/40 shadow-sm"
                  style={{ backgroundColor: prefs?.secondaryColor ?? "var(--brand-secondary)" }}
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
    </>
  );
}
