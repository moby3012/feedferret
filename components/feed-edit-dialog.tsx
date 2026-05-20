"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
import { useUpdateFeed, usePreviewFeedExtraction } from "@/hooks/use-rss-data";

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
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FeedEditDialog({ feed, open, onOpenChange }: FeedEditDialogProps) {
  const t = useTranslations("feedEdit");
  const updateFeed = useUpdateFeed();
  const previewExtraction = usePreviewFeedExtraction();

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
  const [autoFetchFullText, setAutoFetchFullText] = useState(false);
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
    setAutoFetchFullText(feed.autoFetchFullText ?? false);
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
    setPreviewResult(null);
    setPreviewUrl("");
  }, [feed]);

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
          autoFetchFullText,
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
        },
      },
      {
        onSuccess: () => {
          toast.success(t("toasts.saved"));
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

  if (!feed) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                <div className="space-y-3 rounded-2xl border border-border/60 bg-muted/20 p-4">
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
              <div className="flex items-start justify-between gap-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
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
              <div className="flex items-start justify-between gap-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
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

              <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/20 px-4 py-3">
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
                  <div className="rounded-2xl bg-primary/10 p-2 text-primary">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold tracking-[-0.02em]">Scout Studio</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Guided extraction: paste an article URL, preview the cleaned content, then apply the best selector candidate.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/20 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{t("fulltext.autoFetchFullText")}</p>
                  <p className="text-xs text-muted-foreground">{t("fulltext.fetchesOriginalPage")}</p>
                </div>
                <Switch checked={autoFetchFullText} onCheckedChange={setAutoFetchFullText} />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">{t("fulltext.articleBodySelector")}</Label>
                <Input
                  value={fullTextSelector}
                  onChange={(e) => setFullTextSelector(e.target.value)}
                  placeholder={t("fulltext.selectorPlaceholder")}
                  className="rounded-xl h-10 border-border/70 bg-background/70 font-mono text-sm"
                />
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

              <div className="rounded-2xl border border-border/60 bg-muted/20 p-4 space-y-3">
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
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Eye className="w-3.5 h-3.5" />
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
                            className="rounded-xl border border-border/60 bg-background/70 p-3 text-left transition hover:border-primary/50 hover:bg-primary/5"
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
                            <div className="mt-2 flex gap-2 text-[10px] text-muted-foreground">
                              <span>{candidate.paragraphCount} {t("fulltext.paragraphs")}</span>
                              <span>{candidate.linkCount} {t("fulltext.links")}</span>
                              {index === 0 && (
                                <span className="inline-flex items-center gap-1 text-primary">
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
              <div className="rounded-2xl border border-border/60 bg-muted/20 p-4">
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
                <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3">
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
              onClick={() => onOpenChange(false)}
            >
              {t("buttons.cancel")}
            </Button>
            <Button
              className="rounded-xl"
              disabled={updateFeed.isPending}
              onClick={handleSave}
            >
              {updateFeed.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              {t("buttons.saveSettings")}
            </Button>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
