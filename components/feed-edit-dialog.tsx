"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations, useFormatter } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { ResponsiveTabsNav } from "@/components/responsive-tabs-nav";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { CheckCircle2, Eye, Loader2, Sparkles } from "lucide-react";
import { useUpdateFeed, usePreviewFeedExtraction, useProposeAiFullTextSelector, useAiSettings } from "@/hooks/use-rss-data";
import { resolveFullTextMode, type FullTextMode } from "@/lib/full-text-mode";

interface FeedEditDialogProps {
  feed: {
    id: string;
    name: string;
    url: string;
    authType?: string | null;
    authUsername?: string | null;
    authPassword?: string | null;
    customUserAgent?: string | null;
    fetchTimeoutSecs?: number | null;
    sslVerify?: boolean;
    maxSizeKb?: number | null;
    fullTextSelector?: string | null;
    fullTextRemoveSelectors?: string | null;
    autoFetchFullText?: boolean;
    fullTextMode?: string | null;
    defaultContentFormat?: string | null;
    sourceType?: string | null;
    priority?: string | null;
    unicityCriteria?: string | null;
    unicityCriteriaForced?: boolean;
    scraperConfig?: string | null;
    httpOptions?: string | null;
    fullTextConditions?: string | null;
    filtersActionRead?: string | null;
    retentionDays?: number | null;
    keepMinArticles?: number | null;
    hideFromAllFeeds?: boolean;
    hideArticleImage?: boolean;
    readerFontSizeOverride?: string | null;
    readerWidthOverride?: string | null;
    openOriginalOverride?: boolean | null;
    // Read-only health/telemetry surfaced in the "How this feed is fetched" panel.
    lastStatus?: string | null;
    lastError?: string | null;
    lastFetchedAt?: string | Date | null;
    consecutiveFailureCount?: number | null;
    autoMuted?: boolean | null;
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FeedEditDialog({ feed, open, onOpenChange }: FeedEditDialogProps) {
  const t = useTranslations("feedEdit");
  const format = useFormatter();
  const updateFeed = useUpdateFeed();
  const previewExtraction = usePreviewFeedExtraction();
  const proposeAiSelector = useProposeAiFullTextSelector();
  const { data: aiSettings } = useAiSettings();
  const aiConfigured = Boolean(aiSettings?.provider);

  const [authType, setAuthType] = useState<string>("none");
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [customUserAgent, setCustomUserAgent] = useState("");
  const [updateFrequency, setUpdateFrequency] = useState("");
  const [fetchTimeoutSecs, setFetchTimeoutSecs] = useState("");
  const [sslVerify, setSslVerify] = useState(true);
  const [maxSizeKb, setMaxSizeKb] = useState("");
  const [fullTextSelector, setFullTextSelector] = useState("");
  const [fullTextRemoveSelectors, setFullTextRemoveSelectors] = useState("");
  const [fullTextConditions, setFullTextConditions] = useState("");
  const [fullTextMode, setFullTextMode] = useState<FullTextMode>("off");
  const [defaultContentFormat, setDefaultContentFormat] = useState<"html" | "markdown">("html");
  const [sourceType, setSourceType] = useState("rss");
  const [priority, setPriority] = useState("main");
  const [unicityCriteria, setUnicityCriteria] = useState("id");
  const [unicityCriteriaForced, setUnicityCriteriaForced] = useState(false);
  const [scraperConfig, setScraperConfig] = useState("");
  const [httpOptions, setHttpOptions] = useState("");
  const [filtersActionRead, setFiltersActionRead] = useState("");
  const [retentionDays, setRetentionDays] = useState("");
  const [keepMinArticles, setKeepMinArticles] = useState("");
  const [hideFromAllFeeds, setHideFromAllFeeds] = useState(false);
  const [hideArticleImage, setHideArticleImage] = useState(false);
  const [readerFontSizeOverride, setReaderFontSizeOverride] = useState("inherit");
  const [readerWidthOverride, setReaderWidthOverride] = useState("inherit");
  const [openOriginalOverride, setOpenOriginalOverride] = useState("inherit");
  const [previewUrl, setPreviewUrl] = useState("");
  const [activeTab, setActiveTab] = useState("auth");
  const [previewResult, setPreviewResult] = useState<{
    html: string;
    charCount: number;
    selectorUsed: string;
    candidates?: Array<{
      selector: string;
      charCount: number;
      paragraphCount: number;
      linkCount: number;
      sample: string;
    }>;
  } | null>(null);
  const [aiSelectorInfo, setAiSelectorInfo] = useState<{ notes: string | null; excerpt: string | null } | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [hydrationTick, setHydrationTick] = useState(0);
  const initialSnapshotRef = useRef<Record<string, unknown> | null>(null);

  // Returns a snapshot of every user-editable field (excludes transient/UI-only
  // state like activeTab, previewUrl, previewResult, and loading flags). Used
  // both to capture the "last persisted" baseline and to read current values
  // for the dirty comparison, so the two can never drift out of sync.
  const getFormValues = () => ({
    authType,
    authUsername,
    authPassword,
    customUserAgent,
    updateFrequency,
    fetchTimeoutSecs,
    sslVerify,
    maxSizeKb,
    fullTextSelector,
    fullTextRemoveSelectors,
    fullTextConditions,
    fullTextMode,
    defaultContentFormat,
    sourceType,
    priority,
    unicityCriteria,
    unicityCriteriaForced,
    scraperConfig,
    httpOptions,
    filtersActionRead,
    retentionDays,
    keepMinArticles,
    hideFromAllFeeds,
    hideArticleImage,
    readerFontSizeOverride,
    readerWidthOverride,
    openOriginalOverride,
  });

  useEffect(() => {
    if (!feed) return;
    setActiveTab("auth");
    setAuthType(feed.authType || "none");
    setAuthUsername(feed.authUsername || "");
    setAuthPassword(feed.authPassword || "");
    setCustomUserAgent(feed.customUserAgent || "");
    setUpdateFrequency((feed as any).updateFrequency ? String((feed as any).updateFrequency) : "");
    setFetchTimeoutSecs(feed.fetchTimeoutSecs ? String(feed.fetchTimeoutSecs) : "");
    setSslVerify(feed.sslVerify !== false);
    setMaxSizeKb(feed.maxSizeKb ? String(feed.maxSizeKb) : "");
    setFullTextSelector(feed.fullTextSelector || "");
    setFullTextRemoveSelectors(feed.fullTextRemoveSelectors || "");
    setFullTextConditions(feed.fullTextConditions || "");
    // Legacy feeds may only have `autoFetchFullText: true` set, with
    // `fullTextMode` still at its "off" default — resolveFullTextMode()
    // is the single source of truth for reconciling the two, so the
    // dialog shows "Custom selector" for those feeds too.
    setFullTextMode(resolveFullTextMode(feed));
    setDefaultContentFormat(feed.defaultContentFormat === "markdown" ? "markdown" : "html");
    setSourceType(feed.sourceType || "rss");
    setPriority(feed.priority || "main");
    setUnicityCriteria(feed.unicityCriteria || "id");
    setUnicityCriteriaForced(feed.unicityCriteriaForced ?? false);
    setScraperConfig(feed.scraperConfig || "");
    setHttpOptions(feed.httpOptions || "");
    setFiltersActionRead(feed.filtersActionRead || "");
    setRetentionDays(feed.retentionDays ? String(feed.retentionDays) : "");
    setKeepMinArticles(feed.keepMinArticles ? String(feed.keepMinArticles) : "");
    setHideFromAllFeeds(feed.hideFromAllFeeds ?? false);
    setHideArticleImage(feed.hideArticleImage ?? false);
    setReaderFontSizeOverride(feed.readerFontSizeOverride || "inherit");
    setReaderWidthOverride(feed.readerWidthOverride || "inherit");
    setOpenOriginalOverride(
      feed.openOriginalOverride === null || feed.openOriginalOverride === undefined
        ? "inherit"
        : feed.openOriginalOverride ? "on" : "off",
    );
    setPreviewResult(null);
    setPreviewUrl("");
    setAiSelectorInfo(null);
    setShowDiscardConfirm(false);
    // The field setters above only take effect on the next render, so we can't
    // snapshot from this closure yet. Bump a tick to trigger the snapshot
    // effect below once the hydrated values have actually committed.
    setHydrationTick((tick) => tick + 1);
  }, [feed]);

  // Runs after the hydration effect's state updates have committed, so
  // getFormValues() here reflects the freshly hydrated fields — this becomes
  // the "last persisted" baseline for the dirty check.
  useEffect(() => {
    initialSnapshotRef.current = getFormValues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrationTick]);

  const handleSave = () => {
    if (!feed) return;
    updateFeed.mutate(
      {
        feedId: feed.id,
        data: {
          authType: authType === "none" ? null : authType,
          authUsername: authType === "basic" ? authUsername || null : null,
          authPassword: authType === "basic" ? authPassword || null : null,
          customUserAgent: customUserAgent.trim() || null,
          updateFrequency: updateFrequency ? parseInt(updateFrequency) : null,
          fetchTimeoutSecs: fetchTimeoutSecs ? parseInt(fetchTimeoutSecs) : null,
          sslVerify,
          maxSizeKb: maxSizeKb ? parseInt(maxSizeKb) : null,
          fullTextSelector: fullTextSelector.trim() || null,
          fullTextRemoveSelectors: fullTextRemoveSelectors.trim() || null,
          fullTextConditions: fullTextConditions.trim() || null,
          fullTextMode,
          // Keep the legacy boolean in lockstep with the new mode so the two
          // controls never disagree (resolveFullTextMode() otherwise falls
          // back to this flag for feeds saved before fullTextMode existed).
          autoFetchFullText: fullTextMode === "selector",
          defaultContentFormat,
          sourceType,
          priority,
          unicityCriteria: unicityCriteria.trim() || "id",
          unicityCriteriaForced,
          scraperConfig: scraperConfig.trim() || null,
          httpOptions: httpOptions.trim() || null,
          filtersActionRead: filtersActionRead.trim() || null,
          retentionDays: retentionDays ? parseInt(retentionDays) : null,
          keepMinArticles: keepMinArticles ? parseInt(keepMinArticles) : null,
          hideFromAllFeeds,
          hideArticleImage,
          readerFontSizeOverride: readerFontSizeOverride === "inherit" ? null : readerFontSizeOverride,
          readerWidthOverride: readerWidthOverride === "inherit" ? null : readerWidthOverride,
          openOriginalOverride: openOriginalOverride === "inherit" ? null : openOriginalOverride === "on",
        },
      },
      {
        onSuccess: () => {
          toast.success(t("toasts.saved"));
          // The just-saved values are now the persisted baseline, so re-snapshot
          // before closing — otherwise the dialog would (correctly, but
          // needlessly) look dirty forever after a save.
          initialSnapshotRef.current = getFormValues();
          onOpenChange(false);
        },
        onError: () => toast.error(t("toasts.failedToSave")),
      },
    );
  };

  const handlePreview = () => {
    if (!feed || !previewUrl.trim()) return;
    setPreviewResult(null);
    previewExtraction.mutate(
      { feedId: feed.id, articleUrl: previewUrl.trim() },
      {
        onSuccess: (data) => setPreviewResult(data),
        onError: (e) =>
          toast.error(e instanceof Error ? e.message : t("toasts.previewFailed")),
      },
    );
  };

  const handleAiProposeSelector = async () => {
    if (!feed) return;
    setAiSelectorInfo(null);
    try {
      const result = await proposeAiSelector.mutateAsync(feed.id);
      if (!result.success) {
        toast.error(result.error || t("fulltext.aiProposeFailed"));
        return;
      }
      setFullTextSelector(result.selector);
      setFullTextMode("selector");
      setAiSelectorInfo({ notes: result.notes, excerpt: result.excerpt });
      toast.success(t("fulltext.aiProposeSuccess"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("fulltext.aiProposeFailed"));
    }
  };

  const isDirty = (() => {
    const snapshot = initialSnapshotRef.current;
    if (!snapshot) return false;
    const current = getFormValues();
    return (Object.keys(current) as Array<keyof typeof current>).some(
      (key) => current[key] !== snapshot[key],
    );
  })();

  // Radix fires onOpenChange(false) for backdrop clicks, Escape, and the X
  // button alike, so intercepting it here covers every close path. Opens (and
  // closes with no unsaved changes) pass straight through unchanged.
  const handleDialogOpenChange = (next: boolean) => {
    if (!next && isDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    onOpenChange(next);
  };

  const handleDiscardChanges = () => {
    setShowDiscardConfirm(false);
    onOpenChange(false);
  };

  if (!feed) return null;

  // "How this feed is fetched" transparency panel.
  // Method + full-text summary reflect the *current* (possibly edited) form
  // state so it reads as a live preview; health reflects the last saved sync.
  const fetchMethodLabel =
    sourceType === "rss"
      ? t("fetch.transparency.methodRss")
      : sourceType === "JSONFeed"
        ? t("fetch.transparency.methodJsonFeed")
        : t("fetch.transparency.methodScraper", { type: sourceType });
  const fullTextSummary =
    fullTextMode === "auto"
      ? t("fetch.transparency.fullTextAuto")
      : fullTextMode === "selector"
        ? t("fetch.transparency.fullTextSelector")
        : fullTextMode === "ai"
          ? t("fetch.transparency.fullTextAi")
          : t("fetch.transparency.fullTextOff");
  const lastStatus = feed.lastStatus ?? "pending";
  const lastFetchedAt = feed.lastFetchedAt ? new Date(feed.lastFetchedAt) : null;
  const consecutiveFailures = feed.consecutiveFailureCount ?? 0;
  const statusLabel =
    lastStatus === "ok"
      ? t("fetch.transparency.statusOk")
      : lastStatus === "error"
        ? t("fetch.transparency.statusError")
        : t("fetch.transparency.statusPending");
  const statusToneClass =
    lastStatus === "ok"
      ? "bg-emerald-500"
      : lastStatus === "error"
        ? "bg-destructive"
        : "bg-muted-foreground";

  return (
    <>
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="flex h-[min(92dvh,760px)] w-[calc(100vw-1rem)] max-w-2xl flex-col rounded-[2rem] border border-border/70 bg-background p-0 shadow-2xl">
        <DialogHeader className="border-b border-border/60 bg-card/95 px-5 py-5 backdrop-blur-2xl sm:px-8 sm:py-6">
          <DialogTitle className="text-xl font-semibold tracking-[-0.04em] sm:text-2xl">
            {feed.name}
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground truncate">
            {feed.url}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
          <div className="px-5 pt-4 sm:px-8">
            <ResponsiveTabsNav
              value={activeTab}
              onValueChange={setActiveTab}
              options={[
                { value: "auth", label: t("authTab") },
                { value: "fetch", label: t("fetchTab") },
                { value: "behavior", label: t("behaviorTab") },
                { value: "retention", label: t("retentionTab") },
                { value: "fulltext", label: t("fullTextTab") },
                { value: "scout", label: t("scoutTab") },
              ]}
              triggerClassName="px-5 py-2 text-sm"
            />
          </div>

          <ScrollArea className="min-h-0 flex-1">
          <div className="px-5 py-6 space-y-5 sm:px-8">
            <TabsContent value="auth" className="mt-0 space-y-5">
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t("auth.authType")}</Label>
                <Select value={authType} onValueChange={setAuthType}>
                  <SelectTrigger className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    <SelectItem value="none">{t("auth.none")}</SelectItem>
                    <SelectItem value="basic">{t("auth.httpBasicAuth")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {authType === "basic" && (
                <div className="space-y-3 rounded-2xl ui-control-surface border p-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("auth.username")}</Label>
                    <Input
                      value={authUsername}
                      onChange={(e) => setAuthUsername(e.target.value)}
                      placeholder={t("auth.usernamePlaceholder")}
                      className="rounded-xl h-10 border-border/70 bg-background/70"
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("auth.password")}</Label>
                    <Input
                      type="password"
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      placeholder={t("auth.passwordPlaceholder")}
                      className="rounded-xl h-10 border-border/70 bg-background/70"
                      autoComplete="new-password"
                    />
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {t("auth.credentialsUsage")}
              </p>
            </TabsContent>

            <TabsContent value="behavior" className="mt-0 space-y-5">
              <div className="flex items-start justify-between gap-4 rounded-2xl ui-control-surface border p-4">
                <div className="space-y-1 min-w-0">
                  <Label className="text-sm font-medium cursor-pointer" htmlFor="hide-from-all">{t("behavior.hideFromAllArticles")}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t("behavior.articlesWontAppear")}
                  </p>
                </div>
                <Switch
                  id="hide-from-all"
                  checked={hideFromAllFeeds}
                  onCheckedChange={setHideFromAllFeeds}
                  className="shrink-0 mt-0.5"
                />
              </div>
              <div className="flex items-start justify-between gap-4 rounded-2xl ui-control-surface border p-4">
                <div className="space-y-1 min-w-0">
                  <Label className="text-sm font-medium cursor-pointer" htmlFor="hide-article-image">{t("behavior.hideArticleHeroImage")}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t("behavior.suppressHeroImage")}
                  </p>
                </div>
                <Switch
                  id="hide-article-image"
                  checked={hideArticleImage}
                  onCheckedChange={setHideArticleImage}
                  className="shrink-0 mt-0.5"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("reader.fontSizeLabel")}</Label>
                <Select value={readerFontSizeOverride} onValueChange={setReaderFontSizeOverride}>
                  <SelectTrigger className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    <SelectItem value="inherit">{t("reader.inherit")}</SelectItem>
                    <SelectItem value="small">{t("reader.fontSizeSmall")}</SelectItem>
                    <SelectItem value="medium">{t("reader.fontSizeMedium")}</SelectItem>
                    <SelectItem value="large">{t("reader.fontSizeLarge")}</SelectItem>
                    <SelectItem value="xl">{t("reader.fontSizeXl")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("reader.fontSizeDescription")}</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("reader.widthLabel")}</Label>
                <Select value={readerWidthOverride} onValueChange={setReaderWidthOverride}>
                  <SelectTrigger className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    <SelectItem value="inherit">{t("reader.inherit")}</SelectItem>
                    <SelectItem value="normal">{t("reader.widthNormal")}</SelectItem>
                    <SelectItem value="wide">{t("reader.widthWide")}</SelectItem>
                    <SelectItem value="full">{t("reader.widthFull")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("reader.widthDescription")}</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("reader.openOriginalLabel")}</Label>
                <Select value={openOriginalOverride} onValueChange={setOpenOriginalOverride}>
                  <SelectTrigger className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    <SelectItem value="inherit">{t("reader.inherit")}</SelectItem>
                    <SelectItem value="on">{t("reader.on")}</SelectItem>
                    <SelectItem value="off">{t("reader.off")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("reader.openOriginalDescription")}</p>
              </div>
            </TabsContent>

            <TabsContent value="retention" className="mt-0 space-y-5">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("retention.keepDays")}</Label>
                <Input
                  type="number"
                  min={0}
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(e.target.value)}
                  placeholder={t("retention.useUserDefault")}
                  className="rounded-xl h-10 border-border/70 bg-background/70"
                />
                <p className="text-xs text-muted-foreground">
                  {t("retention.deleteOlderArticles")}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("retention.minimumArticles")}</Label>
                <Input
                  type="number"
                  min={0}
                  value={keepMinArticles}
                  onChange={(e) => setKeepMinArticles(e.target.value)}
                  placeholder={t("retention.useUserDefault")}
                  className="rounded-xl h-10 border-border/70 bg-background/70"
                />
                <p className="text-xs text-muted-foreground">
                  {t("retention.alwaysKeep")}
                </p>
              </div>
            </TabsContent>

            <TabsContent value="fetch" className="mt-0 space-y-5">
              <div className="rounded-2xl border border-border/70 bg-muted/30 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{t("fetch.transparency.title")}</p>
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={`h-2 w-2 rounded-full ${statusToneClass}`} aria-hidden="true" />
                    {statusLabel}
                  </span>
                </div>
                <dl className="space-y-2 text-sm">
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
                    <dt className="text-muted-foreground">{t("fetch.transparency.methodLabel")}</dt>
                    <dd className="font-medium sm:text-right">{fetchMethodLabel}</dd>
                  </div>
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
                    <dt className="text-muted-foreground">{t("fetch.transparency.fullTextLabel")}</dt>
                    <dd className="font-medium sm:text-right">{fullTextSummary}</dd>
                  </div>
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
                    <dt className="text-muted-foreground">{t("fetch.transparency.lastCheckedLabel")}</dt>
                    <dd className="font-medium sm:text-right">
                      {lastFetchedAt ? format.relativeTime(lastFetchedAt) : t("fetch.transparency.never")}
                    </dd>
                  </div>
                  <div className="flex flex-col gap-0.5 break-all sm:flex-row sm:justify-between sm:gap-4">
                    <dt className="text-muted-foreground">{t("fetch.transparency.sourceUrlLabel")}</dt>
                    <dd className="font-mono text-xs text-muted-foreground sm:max-w-[60%] sm:text-right">{feed.url}</dd>
                  </div>
                </dl>
                {consecutiveFailures > 0 && (
                  <p className="text-xs text-destructive">
                    {t("fetch.transparency.consecutiveFailures", { count: consecutiveFailures })}
                  </p>
                )}
                {feed.lastError && lastStatus === "error" && (
                  <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive break-words">
                    {feed.lastError}
                  </p>
                )}
                {feed.autoMuted && (
                  <p className="text-xs text-muted-foreground">{t("fetch.transparency.mutedNote")}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("fetch.updateInterval")}</Label>
                <Input
                  type="number"
                  min={5}
                  max={1440}
                  value={updateFrequency}
                  onChange={(e) => setUpdateFrequency(e.target.value)}
                  placeholder={t("fetch.globalDefault")}
                  className="rounded-xl h-10 border-border/70 bg-background/70"
                />
                <p className="text-xs text-muted-foreground">{t("fetch.overrideSync")}</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("fetch.customUserAgent")}</Label>
                <Input
                  value={customUserAgent}
                  onChange={(e) => setCustomUserAgent(e.target.value)}
                  placeholder={t("fetch.userAgentDefault")}
                  className="rounded-xl h-10 border-border/70 bg-background/70"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">{t("fetch.timeout")}</Label>
                  <Input
                    type="number"
                    min={5}
                    max={120}
                    value={fetchTimeoutSecs}
                    onChange={(e) => setFetchTimeoutSecs(e.target.value)}
                    placeholder={t("fetch.timeoutDefault")}
                    className="rounded-xl h-10 border-border/70 bg-background/70"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">{t("fetch.maxSize")}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={maxSizeKb}
                    onChange={(e) => setMaxSizeKb(e.target.value)}
                    placeholder={t("fetch.unlimited")}
                    className="rounded-xl h-10 border-border/70 bg-background/70"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between rounded-2xl ui-control-surface border px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{t("fetch.verifySslCertificate")}</p>
                  <p className="text-xs text-muted-foreground">{t("fetch.disableOnlyForSelfSigned")}</p>
                </div>
                <Switch checked={sslVerify} onCheckedChange={setSslVerify} />
              </div>
            </TabsContent>

            <TabsContent value="fulltext" className="mt-0 space-y-5">
              <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
                <div className="flex items-start gap-3">
                  <div className="ui-brand-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl">
                    <Sparkles className="size-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold tracking-[-0.02em]">{t("fulltext.scoutStudioTitle")}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("fulltext.scoutStudioDescription")}
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("fulltext.fullTextModeLabel")}</Label>
                <Select value={fullTextMode} onValueChange={(value) => setFullTextMode(value as FullTextMode)}>
                  <SelectTrigger className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    <SelectItem value="off">{t("fulltext.fullTextModeOff")}</SelectItem>
                    <SelectItem value="auto">{t("fulltext.fullTextModeAuto")}</SelectItem>
                    <SelectItem value="selector">{t("fulltext.fullTextModeSelector")}</SelectItem>
                    {aiConfigured && <SelectItem value="ai">{t("fulltext.fullTextModeAi")}</SelectItem>}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("fulltext.fullTextModeDescription")}</p>
                {fullTextMode === "ai" && (
                  <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
                    {t("fulltext.fullTextModeAiWarning")}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm font-medium">{t("fulltext.articleBodySelector")}</Label>
                  {aiConfigured && feed && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={proposeAiSelector.isPending}
                      onClick={handleAiProposeSelector}
                    >
                      {proposeAiSelector.isPending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        `✨ ${t("fulltext.aiProposeButton")}`
                      )}
                    </Button>
                  )}
                </div>
                <Input
                  value={fullTextSelector}
                  onChange={(e) => setFullTextSelector(e.target.value)}
                  placeholder={t("fulltext.selectorPlaceholder")}
                  className="rounded-xl h-10 border-border/70 bg-background/70 font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">{t("fulltext.selectorAppliesHint")}</p>
                {aiSelectorInfo && (
                  <div className="rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground space-y-1">
                    {aiSelectorInfo.notes && <p className="italic">{aiSelectorInfo.notes}</p>}
                    {aiSelectorInfo.excerpt && (
                      <p>
                        {aiSelectorInfo.excerpt.length > 150
                          ? `${aiSelectorInfo.excerpt.slice(0, 150)}…`
                          : aiSelectorInfo.excerpt}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("fulltext.removeSelectors")}</Label>
                <Input
                  value={fullTextRemoveSelectors}
                  onChange={(e) => setFullTextRemoveSelectors(e.target.value)}
                  placeholder={t("fulltext.removePlaceholder")}
                  className="rounded-xl h-10 border-border/70 bg-background/70 font-mono text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("fulltext.contentFormatLabel")}</Label>
                <Select value={defaultContentFormat} onValueChange={(value) => setDefaultContentFormat(value as "html" | "markdown")}>
                  <SelectTrigger className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    <SelectItem value="html">{t("fulltext.contentFormatHtml")}</SelectItem>
                    <SelectItem value="markdown">{t("fulltext.contentFormatMarkdown")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("fulltext.contentFormatDescription")}</p>
              </div>

              <div className="rounded-2xl ui-control-surface border p-4 space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {t("fulltext.testExtraction")}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={previewUrl}
                    onChange={(e) => setPreviewUrl(e.target.value)}
                    placeholder={t("fulltext.articleUrlPlaceholder")}
                    className="rounded-xl h-9 border-border/70 bg-background/70 text-sm flex-1"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-xl gap-1.5 shrink-0"
                    disabled={!previewUrl.trim() || previewExtraction.isPending}
                    onClick={handlePreview}
                  >
                    {previewExtraction.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                    {t("fulltext.preview")}
                  </Button>
                </div>
                {previewResult && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {previewResult.charCount.toLocaleString()} {t("fulltext.charsExtracted")} <code className="font-mono">{previewResult.selectorUsed}</code>
                    </p>
                    {previewResult.candidates && previewResult.candidates.length > 0 && (
                      <div className="grid gap-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          {t("fulltext.scoutSelectorCandidates")}
                        </p>
                        {previewResult.candidates.map((candidate, index) => (
                          <button
                            key={`${candidate.selector}-${index}`}
                            type="button"
                            className="rounded-xl border border-border/60 bg-background/70 p-3 text-start transition hover:border-primary/50 hover:bg-primary/5"
                            onClick={() => {
                              setFullTextSelector(candidate.selector);
                              toast.success(t("toasts.selectorApplied"));
                            }}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <code className="truncate font-mono text-xs">{candidate.selector}</code>
                              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                {candidate.charCount.toLocaleString()} {t("fulltext.chars")}
                              </span>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{candidate.sample}</p>
                            <div className="mt-2 flex gap-2 text-xs text-muted-foreground">
                              <span>{candidate.paragraphCount} {t("fulltext.paragraphs")}</span>
                              <span>{candidate.linkCount} {t("fulltext.links")}</span>
                              {index === 0 && (
                                <span className="inline-flex items-center gap-1 text-foreground">
                                  <CheckCircle2 className="h-3 w-3" /> {t("fulltext.recommended")}
                                </span>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    <div
                      className="max-h-48 overflow-y-auto rounded-xl bg-background/80 p-3 text-sm prose prose-sm dark:prose-invert max-w-none"
                      dangerouslySetInnerHTML={{ __html: previewResult.html.slice(0, 10_000) }}
                    />
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="scout" className="mt-0 space-y-5">
              <div className="rounded-2xl ui-control-surface border p-4">
                <h3 className="font-semibold tracking-[-0.02em]">{t("scout.scoutAdvanced")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("scout.customHandling")}
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">{t("scout.sourceType")}</Label>
                  <Select value={sourceType} onValueChange={setSourceType}>
                    <SelectTrigger className="rounded-xl h-10 border-border/70 bg-background/70">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="rounded-2xl">
                      <SelectItem value="rss">{t("scout.rssAtom")}</SelectItem>
                      <SelectItem value="JSONFeed">{t("scout.jsonFeed")}</SelectItem>
                      <SelectItem value="JSON+DotNotation">{t("scout.jsonDotNotation")}</SelectItem>
                      <SelectItem value="HTML+XPath">{t("scout.htmlXpath")}</SelectItem>
                      <SelectItem value="XML+XPath">{t("scout.xmlXpath")}</SelectItem>
                      <SelectItem value="HTML+XPath+JSON+DotNotation">{t("scout.htmlXpathJson")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">{t("scout.priority")}</Label>
                  <Select value={priority} onValueChange={setPriority}>
                    <SelectTrigger className="rounded-xl h-10 border-border/70 bg-background/70">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="rounded-2xl">
                      <SelectItem value="important">{t("scout.important")}</SelectItem>
                      <SelectItem value="main">{t("scout.mainStream")}</SelectItem>
                      <SelectItem value="category">{t("scout.categoryOnly")}</SelectItem>
                      <SelectItem value="feed">{t("scout.feedOnly")}</SelectItem>
                      <SelectItem value="hidden">{t("scout.hidden")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">{t("scout.unicityCriteria")}</Label>
                  <Input
                    value={unicityCriteria}
                    onChange={(e) => setUnicityCriteria(e.target.value)}
                    placeholder={t("scout.unicityCriteriaPlaceholder")}
                    className="rounded-xl h-10 border-border/70 bg-background/70 font-mono text-sm"
                  />
                </div>
                <div className="flex items-center gap-2 rounded-2xl ui-control-surface border px-4 py-3">
                  <span className="text-sm">{t("scout.forced")}</span>
                  <Switch checked={unicityCriteriaForced} onCheckedChange={setUnicityCriteriaForced} />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("scout.scraperConfig")}</Label>
                <Textarea
                  value={scraperConfig}
                  onChange={(e) => setScraperConfig(e.target.value)}
                  placeholder='{\"xpath\":{\"xPathItem\":\"//article\",\"xPathItemTitle\":\".//h2\"}}'
                  className="min-h-28 rounded-xl border-border/70 bg-background/70 font-mono text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("scout.httpOptions")}</Label>
                <Textarea
                  value={httpOptions}
                  onChange={(e) => setHttpOptions(e.target.value)}
                  placeholder='{\"CURLOPT_HTTPHEADER\":\"Accept: application/json\",\"CURLOPT_USERAGENT\":\"FeedFerret\"}'
                  className="min-h-24 rounded-xl border-border/70 bg-background/70 font-mono text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("scout.fullContentConditions")}</Label>
                <Textarea
                  value={fullTextConditions}
                  onChange={(e) => setFullTextConditions(e.target.value)}
                  placeholder="cssFullContentConditions, one per line"
                  className="min-h-20 rounded-xl border-border/70 bg-background/70 font-mono text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("scout.autoReadFilters")}</Label>
                <Textarea
                  value={filtersActionRead}
                  onChange={(e) => setFiltersActionRead(e.target.value)}
                  placeholder="filtersActionRead, one per line"
                  className="min-h-20 rounded-xl border-border/70 bg-background/70 font-mono text-xs"
                />
              </div>
            </TabsContent>
          </div>
          </ScrollArea>

          <div className="flex flex-col-reverse gap-2 border-t border-border/60 bg-background/95 px-5 py-4 sm:flex-row sm:justify-end sm:px-8">
            <Button
              variant="ghost"
              className="rounded-xl"
              onClick={() => handleDialogOpenChange(false)}
            >
              {t("buttons.cancel")}
            </Button>
            <Button
              className="rounded-xl"
              disabled={updateFeed.isPending}
              onClick={handleSave}
            >
              {updateFeed.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin me-2" />
              ) : null}
              {t("buttons.saveSettings")}
            </Button>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>

    <AlertDialog open={showDiscardConfirm} onOpenChange={setShowDiscardConfirm}>
      <AlertDialogContent className="rounded-3xl border-border/70 bg-background">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("unsavedChanges.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("unsavedChanges.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="rounded-2xl">
            {t("unsavedChanges.keepEditing")}
          </AlertDialogCancel>
          <AlertDialogAction
            className="rounded-2xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={handleDiscardChanges}
          >
            {t("unsavedChanges.discardChanges")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
