"use client";

import { Input } from "@/components/ui/input";
import { isCountDisplay } from "@/lib/count-display";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { AlignLeft, ArrowDownAZ, Clock, ExternalLink, Languages, Layers, ScrollText, CheckCheck, EyeOff, Hash, Globe, HardDrive } from "lucide-react";
import { OfflineStorageControls } from "@/components/offline-storage-controls";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useReadingPreferences, useUpdateGlobalSettings, useUpdateUiLanguage, useUpdateDisplayTimezone } from "@/hooks/use-rss-data";
import { Switch } from "@/components/ui/switch";
import { PrefRow, getCommonTimezones } from "@/components/settings/pref-row";

export function ReadingSettings() {
  const t = useTranslations();
  const router = useRouter();
  const { data: prefs } = useReadingPreferences();
  const updateSettings = useUpdateGlobalSettings();
  const updateUiLang = useUpdateUiLanguage();
  const updateDisplayTimezone = useUpdateDisplayTimezone();
  const update = (data: Parameters<typeof updateSettings.mutate>[0]) => updateSettings.mutate(data);

  return (
    <>
      <PrefRow icon={Globe} title={t("settings.mediaProxyImages")} description={t("settings.mediaProxyImagesDescription")}>
        <Switch aria-label={t("settings.mediaProxyImages")} checked={prefs?.mediaProxyImages ?? false}
          onCheckedChange={(checked) => update({ mediaProxyImages: checked })} />
      </PrefRow>
      <PrefRow icon={Globe} title={t("settings.mediaYoutubeFrontend")} description={t("settings.mediaFrontendsDescription")}>
        <Select value={prefs?.mediaYoutubeFrontend ?? "invidious"} onValueChange={value => update({ mediaYoutubeFrontend: value })}>
          <SelectTrigger aria-label={t("settings.mediaYoutubeFrontend")}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="invidious">Invidious</SelectItem><SelectItem value="piped">Piped</SelectItem></SelectContent>
        </Select>
      </PrefRow>
      {(["mediaYoutubeInstance", "mediaRedditFrontend", "mediaTwitterInstance"] as const).map(field => (
        <PrefRow key={field} icon={ExternalLink} title={t(`settings.${field}`)} description={t(field === "mediaRedditFrontend" ? "settings.mediaRedditDescription" : "settings.mediaInstanceDescription")}>
          <Input key={prefs?.[field] ?? ""} aria-label={t(`settings.${field}`)} defaultValue={prefs?.[field] ?? ""}
            placeholder="https://…" onBlur={event => {
              const value = event.target.value.trim();
              if (value !== (prefs?.[field] ?? "")) update({ [field]: value });
            }} />
        </PrefRow>
      ))}
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
          <SelectTrigger className="h-10 w-full rounded-panel border-border/70 bg-background/70 sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-panel">
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
          <SelectTrigger className="h-10 w-full rounded-panel border-border/70 bg-background/70 sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-panel">
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
        />
      </PrefRow>

      {/* Mark the current view read when advancing from the end-of-list card */}
      <PrefRow
        icon={CheckCheck}
        title={t("settings.markReadOnAdvance")}
        description={t("settings.markReadOnAdvanceDescription")}
      >
        <Switch
          aria-label={t("settings.markReadOnAdvance")}
          checked={prefs?.markReadOnAdvance ?? false}
          onCheckedChange={(checked) => update({ markReadOnAdvance: checked })}
        />
      </PrefRow>

      {/* Story cluster card: marking a story marks all of its sources */}
      <PrefRow
        icon={Layers}
        title={t("settings.storyReadMode")}
        description={t("settings.storyReadModeDescription")}
      >
        <Switch
          aria-label={t("settings.storyReadMode")}
          checked={(prefs?.clusterReadMode ?? "story") === "story"}
          onCheckedChange={(checked) => update({ clusterReadMode: checked ? "story" : "article" })}
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
          <SelectTrigger className="h-10 w-full rounded-panel border-border/70 bg-background/70 sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-panel">
            <SelectItem value="en">English</SelectItem>
            <SelectItem value="de">Deutsch</SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>

      {/* Display timezone */}
      <PrefRow
        icon={Globe}
        title={t("settings.displayTimezone")}
        description={t("settings.displayTimezoneDescription")}
      >
        <Select
          value={prefs?.displayTimezone ?? "auto"}
          onValueChange={(v) => {
            if (v === "auto") {
              let detected: string | undefined;
              try {
                detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
              } catch {}
              updateDisplayTimezone.mutate(
                { timezone: null, effectiveTimezone: detected },
                { onSuccess: () => router.refresh() },
              );
            } else {
              updateDisplayTimezone.mutate(
                { timezone: v },
                { onSuccess: () => router.refresh() },
              );
            }
          }}
        >
          <SelectTrigger className="h-10 w-full rounded-panel border-border/70 bg-background/70 sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-panel max-h-72">
            <SelectItem value="auto">{t("settings.displayTimezoneAuto")}</SelectItem>
            {getCommonTimezones().map((tz) => (
              <SelectItem key={tz} value={tz}>{tz}</SelectItem>
            ))}
            {prefs?.displayTimezone && !getCommonTimezones().includes(prefs.displayTimezone) && (
              <SelectItem value={prefs.displayTimezone}>{prefs.displayTimezone}</SelectItem>
            )}
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
        />
      </PrefRow>

      {/* Where unread numbers show (spec §4.9.3) */}
      <PrefRow
        icon={Hash}
        title={t("settings.countDisplay")}
        description={t("settings.countDisplayDescription")}
      >
        <Select
          value={prefs?.countDisplay ?? "all"}
          onValueChange={(v) => {
            if (isCountDisplay(v)) update({ countDisplay: v });
          }}
        >
          <SelectTrigger className="h-10 w-full rounded-panel border-border/70 bg-background/70 sm:w-44" aria-label={t("settings.countDisplay")} data-testid="count-display-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-panel">
            <SelectItem value="all">{t("settings.countDisplayOptions.all")}</SelectItem>
            <SelectItem value="categories">{t("settings.countDisplayOptions.categories")}</SelectItem>
            <SelectItem value="off">{t("settings.countDisplayOptions.off")}</SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>

      {/* Offline reading: storage in use */}
      <PrefRow
        icon={HardDrive}
        title={t("settings.offlineReading")}
        description={t("settings.offlineReadingDescription")}
      >
        <OfflineStorageControls />
      </PrefRow>
    </>
  );
}
