"use client";

import { useTranslations, useFormatter } from "next-intl";
import { Mail, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useDigestSettings, useUpdateDigestSettings, useSendTestDigest, usePreviewDigest, useFeeds, useLabels } from "@/hooks/use-rss-data";
import { useInstance } from "@/hooks/use-instance";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getCommonTimezones } from "@/components/settings/pref-row";

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

export function DigestSection() {
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
  // If mail isn't configured on this instance, show why instead of silently
  // vanishing — otherwise a user has no way to tell "not available" apart
  // from "failed to load".
  if (!instanceLoading && instance && !instance.capabilities.mail) {
    return (
      <section className="rounded-panel border border-border/65 bg-card/85 p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-panel opacity-60">
            <Mail className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-title-sm font-semibold tracking-title">{t("digest.title")}</h2>
            <p className="mt-1 text-body-sm leading-6 text-muted-foreground">
              {t("digest.description")}
            </p>
            <p className="mt-2 text-body-sm text-muted-foreground">{t("digest.mailNotConfigured")}</p>
          </div>
        </div>
      </section>
    );
  }

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
    <section className="rounded-panel border border-border/65 bg-card/85 p-5 sm:p-6">
      <div className="flex items-start gap-4 mb-6">
        <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-panel">
          <Mail className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-title-sm font-semibold tracking-title">{t("digest.title")}</h2>
          <p className="mt-1 text-body-sm leading-6 text-muted-foreground">
            {t("digest.description")}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        {/* Enable toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-body-sm font-medium">{t("digest.enableDigestEmails")}</p>
            {digest.digestLastSentAt && (
              <p className="text-footnote text-muted-foreground mt-0.5">
                {t("digest.lastSent")}: {format.dateTime(new Date(digest.digestLastSentAt), { dateStyle: "medium", timeStyle: "short" })}
              </p>
            )}
          </div>
          <Switch
            checked={digest.digestEnabled}
            onCheckedChange={(checked) => update({ digestEnabled: checked })}
          />
        </div>

        {digest.digestEnabled && (
          <div className="animate-fade-in-up flex flex-col gap-5">
            {/* Frequency / Day / Hour / Timezone */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-body-sm font-medium" htmlFor="digest-frequency-select">{t("digest.frequency")}</label>
                <Select
                  value={digest.digestFrequency}
                  onValueChange={(v) => update({ digestFrequency: v })}
                >
                  <SelectTrigger id="digest-frequency-select" className="rounded-panel border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-panel">
                    <SelectItem value="daily">{t("digest.frequencies.daily")}</SelectItem>
                    <SelectItem value="weekdays">{t("digest.frequencies.weekdays")}</SelectItem>
                    <SelectItem value="weekly">{t("digest.frequencies.weekly")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Day of week (weekly only) */}
              {digest.digestFrequency === "weekly" && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-body-sm font-medium" htmlFor="digest-day-select">{t("digest.day")}</label>
                  <Select
                    value={String(digest.digestDayOfWeek)}
                    onValueChange={(v) => update({ digestDayOfWeek: parseInt(v) })}
                  >
                    <SelectTrigger id="digest-day-select" className="rounded-panel border-border/70 bg-background/70 h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="rounded-panel">
                      {DAYS.map((d) => (
                        <SelectItem key={d.value} value={d.value}>{t(d.key)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Hour */}
              <div className="flex flex-col gap-1.5">
                <label className="text-body-sm font-medium" htmlFor="digest-hour-select">{t("digest.hour")}</label>
                <Select
                  value={String(digest.digestHour)}
                  onValueChange={(v) => update({ digestHour: parseInt(v) })}
                >
                  <SelectTrigger id="digest-hour-select" className="rounded-panel border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-panel">
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
                <label className="text-body-sm font-medium" htmlFor="digest-timezone-select">{t("digest.timezone")}</label>
                <Select
                  value={digest.digestTimezone}
                  onValueChange={(v) => update({ digestTimezone: v })}
                >
                  <SelectTrigger id="digest-timezone-select" className="rounded-panel border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-panel max-h-72">
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
                <label className="text-body-sm font-medium" htmlFor="digest-scope-select">{t("digest.include")}</label>
                <Select
                  value={digest.digestScope}
                  onValueChange={(v) => update({ digestScope: v })}
                >
                  <SelectTrigger id="digest-scope-select" className="rounded-panel border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-panel">
                    <SelectItem value="unread">{t("digest.scope.unread")}</SelectItem>
                    <SelectItem value="all">{t("digest.scope.allNew")}</SelectItem>
                    <SelectItem value="starred">{t("digest.scope.starred")}</SelectItem>
                    <SelectItem value="readlater">{t("digest.scope.readLater")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-body-sm font-medium" htmlFor="digest-lookback-select">{t("digest.lookback")}</label>
                <Select
                  value={digest.digestLookbackHours === null ? "since_last" : String(digest.digestLookbackHours)}
                  onValueChange={(v) => {
                    const opt = LOOKBACK_OPTIONS.find((o) => o.value === v);
                    update({ digestLookbackHours: opt ? opt.hours : null });
                  }}
                >
                  <SelectTrigger id="digest-lookback-select" className="rounded-panel border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-panel">
                    {LOOKBACK_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{t(o.key)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-body-sm font-medium" htmlFor="digest-max-select">{t("digest.maxArticles")}</label>
                <Select
                  value={String(digest.digestMaxArticles)}
                  onValueChange={(v) => update({ digestMaxArticles: parseInt(v) })}
                >
                  <SelectTrigger id="digest-max-select" className="rounded-panel border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-panel">
                    {ARTICLE_COUNT_OPTIONS.map((n) => (
                      <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-body-sm font-medium" htmlFor="digest-min-select">{t("digest.minArticles")}</label>
                <Select
                  value={String(digest.digestMinArticles)}
                  onValueChange={(v) => update({ digestMinArticles: parseInt(v) })}
                >
                  <SelectTrigger id="digest-min-select" className="rounded-panel border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-panel">
                    {[1, 3, 5, 10, 20].map((n) => (
                      <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <p className="text-footnote text-muted-foreground -mt-2">
              {t("digest.lookbackHint")} {t("digest.minArticlesHint")}
            </p>

            {/* Group by feed + AI summary */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="ui-control-surface flex items-start justify-between rounded-panel border p-4">
                <div className="pr-3">
                  <p className="text-body-sm font-medium">{t("digest.groupByFeed")}</p>
                  <p className="text-footnote text-muted-foreground mt-0.5">{t("digest.groupByFeedHint")}</p>
                </div>
                <Switch
                  checked={digest.digestGroupByFeed}
                  onCheckedChange={(checked) => update({ digestGroupByFeed: checked })}
                />
              </div>

              <div className="ui-control-surface flex flex-col gap-1.5 rounded-panel border p-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-foreground" />
                  <label className="text-body-sm font-medium" htmlFor="digest-ai-select">{t("digest.aiSummary")}</label>
                </div>
                <Select
                  value={digest.digestAiSummary}
                  onValueChange={(v) => update({ digestAiSummary: v })}
                  disabled={!digest.aiConfigured}
                >
                  <SelectTrigger id="digest-ai-select" className="rounded-panel border-border/70 bg-background/70 h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-panel">
                    <SelectItem value="none">{t("digest.aiSummaryModes.none")}</SelectItem>
                    <SelectItem value="full">{t("digest.aiSummaryModes.full")}</SelectItem>
                    <SelectItem value="per_feed">{t("digest.aiSummaryModes.perFeed")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-footnote text-muted-foreground">
                  {digest.aiConfigured ? t("digest.aiSummaryHint") : t("digest.aiNotConfigured")}
                </p>
              </div>
            </div>

            {/* Feed filter */}
            {feeds.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <label className="text-body-sm font-medium">
                  {t("digest.feedFilter")}{" "}
                  <span className="normal-case font-normal">({t("digest.feedFilterHint")})</span>
                </label>
                <div className="ui-control-surface flex flex-wrap gap-2 rounded-panel border p-3 min-h-[48px]">
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
                          "inline-flex max-w-[14rem] items-center gap-1.5 rounded-panel px-3 py-1 text-footnote font-medium transition-all",
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
                <label className="text-body-sm font-medium">
                  {t("digest.labelFilter")}{" "}
                  <span className="normal-case font-normal">({t("digest.labelFilterHint")})</span>
                </label>
                <div className="ui-control-surface flex flex-wrap gap-2 rounded-panel border p-3 min-h-[48px]">
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
                          "inline-flex items-center gap-1.5 rounded-panel px-3 py-1 text-footnote font-medium transition-all",
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
            <div className="ui-control-surface flex items-start justify-between rounded-panel border p-4">
              <div className="pr-3">
                <p className="text-body-sm font-medium">{t("digest.skipFeatured")}</p>
                <p className="text-footnote text-muted-foreground mt-0.5">{t("digest.skipFeaturedHint")}</p>
              </div>
              <Switch
                checked={digest.digestSkipFeatured}
                onCheckedChange={(checked) => update({ digestSkipFeatured: checked })}
              />
            </div>

            {/* Pause */}
            <div className="ui-control-surface rounded-panel border p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-body-sm font-medium">{isPaused ? `${t("digest.pauseUntil")}: ${format.dateTime(new Date(digest.digestPausedUntil!), { dateStyle: "medium" })}` : t("digest.pauseDigest")}</p>
                  <p className="text-footnote text-muted-foreground mt-0.5">{t("digest.pauseDigestHint")}</p>
                </div>
                {isPaused ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-panel shrink-0"
                    onClick={() => update({ digestPausedUntil: null })}
                  >
                    {t("digest.resumeDigest")}
                  </Button>
                ) : (
                  <Select onValueChange={(v) => {
                    const map: Record<string, number | null> = { tomorrow: 1, "3days": 3, "1week": 7, "2weeks": 14, indefinite: null };
                    pauseUntil(map[v] ?? 7);
                  }}>
                    <SelectTrigger className="rounded-panel border-border/70 bg-background/70 h-9 w-auto min-w-[130px] shrink-0">
                      <SelectValue placeholder={t("digest.pauseDigest")} />
                    </SelectTrigger>
                    <SelectContent className="rounded-panel">
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
                className="rounded-panel h-10"
              >
                <Mail className="w-4 h-4 me-2" />
                {preview.isPending ? t("digest.previewing") : t("digest.preview")}
              </Button>
              <Button
                variant="outline"
                onClick={() => sendTest.mutate()}
                disabled={sendTest.isPending}
                className="rounded-panel h-10"
              >
                <Send className="w-4 h-4 me-2" />
                {sendTest.isPending ? t("digest.sending") : t("digest.sendTestDigest")}
              </Button>
              <div className="flex flex-col gap-0.5 justify-center">
                {preview.data && (
                  <p className={cn("text-body-sm font-medium", preview.data.wouldSend ? "text-foreground" : "text-destructive")}>
                    {preview.data.articleCount === 0
                      ? t("digest.previewEmpty")
                      : !preview.data.wouldSend
                        ? t("digest.previewWouldSkip")
                        : `${t("digest.previewResult", { count: preview.data.articleCount })} ${t("digest.previewFeeds", { count: preview.data.feedBreakdown.length })}`
                    }
                  </p>
                )}
                {!preview.data && (
                  <p className="text-footnote text-muted-foreground">{t("digest.testDigestHint")}</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
