"use client";

import { useState, useEffect } from "react";
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
          toast.success("Feed settings saved");
          onOpenChange(false);
        },
        onError: () => toast.error("Failed to save feed settings"),
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
          toast.error(e instanceof Error ? e.message : "Preview failed"),
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
                { value: "auth", label: "Authentication" },
                { value: "fetch", label: "Fetch Options" },
                { value: "behavior", label: "Behavior" },
                { value: "retention", label: "Retention" },
                { value: "fulltext", label: "Full-Text" },
                { value: "scout", label: "Scout Studio" },
              ]}
              triggerClassName="px-5 py-2 text-sm"
            />
          </div>

          <ScrollArea className="min-h-0 flex-1">
          <div className="px-5 py-6 space-y-5 sm:px-8">
            <TabsContent value="auth" className="mt-0 space-y-5">
              <div className="space-y-2">
                <Label className="text-sm font-medium">Auth type</Label>
                <Select value={authType} onValueChange={setAuthType}>
                  <SelectTrigger className="rounded-2xl border-border/70 bg-background/70 h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-2xl">
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="basic">HTTP Basic Auth</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {authType === "basic" && (
                <div className="space-y-3 rounded-2xl border border-border/60 bg-muted/20 p-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Username</Label>
                    <Input
                      value={authUsername}
                      onChange={(e) => setAuthUsername(e.target.value)}
                      placeholder="username"
                      className="rounded-xl h-10 border-border/70 bg-background/70"
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Password</Label>
                    <Input
                      type="password"
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      placeholder="••••••••"
                      className="rounded-xl h-10 border-border/70 bg-background/70"
                      autoComplete="new-password"
                    />
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Credentials used when fetching this feed&apos;s RSS/Atom URL.
              </p>
            </TabsContent>

            <TabsContent value="behavior" className="mt-0 space-y-5">
              <div className="flex items-start justify-between gap-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
                <div className="space-y-1 min-w-0">
                  <Label className="text-sm font-medium cursor-pointer" htmlFor="hide-from-all">Hide from All Articles</Label>
                  <p className="text-xs text-muted-foreground">
                    Articles from this feed will not appear in the &ldquo;All Articles&rdquo; or &ldquo;All&rdquo; view. The feed remains accessible when selected directly.
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
                  <Label className="text-sm font-medium cursor-pointer" htmlFor="hide-article-image">Hide article hero image</Label>
                  <p className="text-xs text-muted-foreground">
                    Suppress the hero image in the article reader. Useful for feeds that embed the same image both as a thumbnail and inside the article body.
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
                <Label className="text-sm font-medium">Keep days</Label>
                <Input
                  type="number"
                  min={0}
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(e.target.value)}
                  placeholder="Use user default"
                  className="rounded-xl h-10 border-border/70 bg-background/70"
                />
                <p className="text-xs text-muted-foreground">
                  Delete read, unstarred, unlabelled articles older than this many days. Leave empty to use the account default.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Minimum articles to keep</Label>
                <Input
                  type="number"
                  min={0}
                  value={keepMinArticles}
                  onChange={(e) => setKeepMinArticles(e.target.value)}
                  placeholder="Use user default"
                  className="rounded-xl h-10 border-border/70 bg-background/70"
                />
                <p className="text-xs text-muted-foreground">
                  Always keep at least this many articles for the feed, even when they are older than the retention window.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="fetch" className="mt-0 space-y-5">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Update interval (minutes)</Label>
                <Input
                  type="number"
                  min={5}
                  max={1440}
                  value={updateFrequency}
                  onChange={(e) => setUpdateFrequency(e.target.value)}
                  placeholder="Global default"
                  className="rounded-xl h-10 border-border/70 bg-background/70"
                />
                <p className="text-xs text-muted-foreground">Override global sync interval for this feed. Increase for slow/rate-limited sources.</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Custom User-Agent</Label>
                <Input
                  value={customUserAgent}
                  onChange={(e) => setCustomUserAgent(e.target.value)}
                  placeholder="FeedFerret/1.0 (default)"
                  className="rounded-xl h-10 border-border/70 bg-background/70"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Timeout (seconds)</Label>
                  <Input
                    type="number"
                    min={5}
                    max={120}
                    value={fetchTimeoutSecs}
                    onChange={(e) => setFetchTimeoutSecs(e.target.value)}
                    placeholder="30 (default)"
                    className="rounded-xl h-10 border-border/70 bg-background/70"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Max size (KB)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={maxSizeKb}
                    onChange={(e) => setMaxSizeKb(e.target.value)}
                    placeholder="Unlimited"
                    className="rounded-xl h-10 border-border/70 bg-background/70"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/20 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">Verify SSL certificate</p>
                  <p className="text-xs text-muted-foreground">Disable only for self-signed certs on trusted servers</p>
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
                  <p className="text-sm font-medium">Auto-fetch full text on sync</p>
                  <p className="text-xs text-muted-foreground">Fetches original article page after each sync</p>
                </div>
                <Switch checked={autoFetchFullText} onCheckedChange={setAutoFetchFullText} />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Article body CSS selector</Label>
                <Input
                  value={fullTextSelector}
                  onChange={(e) => setFullTextSelector(e.target.value)}
                  placeholder="article, .post-content (auto-detect if empty)"
                  className="rounded-xl h-10 border-border/70 bg-background/70 font-mono text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Remove selectors (comma-separated)</Label>
                <Input
                  value={fullTextRemoveSelectors}
                  onChange={(e) => setFullTextRemoveSelectors(e.target.value)}
                  placeholder=".ads, .sidebar, .comments"
                  className="rounded-xl h-10 border-border/70 bg-background/70 font-mono text-sm"
                />
              </div>

              <div className="rounded-2xl border border-border/60 bg-muted/20 p-4 space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Test extraction
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={previewUrl}
                    onChange={(e) => setPreviewUrl(e.target.value)}
                    placeholder="https://example.com/article"
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
                    Preview
                  </Button>
                </div>
                {previewResult && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {previewResult.charCount.toLocaleString()} chars extracted · selector: <code className="font-mono">{previewResult.selectorUsed}</code>
                    </p>
                    {previewResult.candidates && previewResult.candidates.length > 0 && (
                      <div className="grid gap-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Scout selector candidates
                        </p>
                        {previewResult.candidates.map((candidate, index) => (
                          <button
                            key={`${candidate.selector}-${index}`}
                            type="button"
                            className="rounded-xl border border-border/60 bg-background/70 p-3 text-left transition hover:border-primary/50 hover:bg-primary/5"
                            onClick={() => {
                              setFullTextSelector(candidate.selector);
                              toast.success("Selector applied");
                            }}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <code className="truncate font-mono text-xs">{candidate.selector}</code>
                              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                {candidate.charCount.toLocaleString()} chars
                              </span>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{candidate.sample}</p>
                            <div className="mt-2 flex gap-2 text-[10px] text-muted-foreground">
                              <span>{candidate.paragraphCount} paragraphs</span>
                              <span>{candidate.linkCount} links</span>
                              {index === 0 && (
                                <span className="inline-flex items-center gap-1 text-primary">
                                  <CheckCircle2 className="h-3 w-3" /> recommended
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
                <h3 className="font-semibold tracking-[-0.02em]">Scout Studio advanced source controls</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Use these fields when a site needs custom HTML, XML, JSON, or request handling beyond normal RSS/Atom feeds.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Source type</Label>
                  <Select value={sourceType} onValueChange={setSourceType}>
                    <SelectTrigger className="rounded-xl h-10 border-border/70 bg-background/70">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="rounded-2xl">
                      <SelectItem value="rss">RSS / Atom</SelectItem>
                      <SelectItem value="JSONFeed">JSON Feed</SelectItem>
                      <SelectItem value="JSON+DotNotation">JSON + DotNotation</SelectItem>
                      <SelectItem value="HTML+XPath">HTML + XPath</SelectItem>
                      <SelectItem value="XML+XPath">XML + XPath</SelectItem>
                      <SelectItem value="HTML+XPath+JSON+DotNotation">HTML + XPath + JSON</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Priority</Label>
                  <Select value={priority} onValueChange={setPriority}>
                    <SelectTrigger className="rounded-xl h-10 border-border/70 bg-background/70">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="rounded-2xl">
                      <SelectItem value="important">Important</SelectItem>
                      <SelectItem value="main">Main stream</SelectItem>
                      <SelectItem value="category">Category only</SelectItem>
                      <SelectItem value="feed">Feed only</SelectItem>
                      <SelectItem value="hidden">Hidden</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Unicity criteria</Label>
                  <Input
                    value={unicityCriteria}
                    onChange={(e) => setUnicityCriteria(e.target.value)}
                    placeholder="id, link, title, title:link"
                    className="rounded-xl h-10 border-border/70 bg-background/70 font-mono text-sm"
                  />
                </div>
                <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3">
                  <span className="text-sm">Forced</span>
                  <Switch checked={unicityCriteriaForced} onCheckedChange={setUnicityCriteriaForced} />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Scraper config JSON</Label>
                <Textarea
                  value={scraperConfig}
                  onChange={(e) => setScraperConfig(e.target.value)}
                  placeholder='{\"xpath\":{\"xPathItem\":\"//article\",\"xPathItemTitle\":\".//h2\"}}'
                  className="min-h-28 rounded-xl border-border/70 bg-background/70 font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">Stores Scout Studio XPath / JSON DotNotation settings imported from OPML.</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">HTTP / cURL options JSON</Label>
                <Textarea
                  value={httpOptions}
                  onChange={(e) => setHttpOptions(e.target.value)}
                  placeholder='{\"CURLOPT_HTTPHEADER\":\"Accept: application/json\",\"CURLOPT_USERAGENT\":\"FeedFerret\"}'
                  className="min-h-24 rounded-xl border-border/70 bg-background/70 font-mono text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Full-content conditions</Label>
                <Textarea
                  value={fullTextConditions}
                  onChange={(e) => setFullTextConditions(e.target.value)}
                  placeholder="cssFullContentConditions, one per line"
                  className="min-h-20 rounded-xl border-border/70 bg-background/70 font-mono text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Auto-read filters</Label>
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
              Cancel
            </Button>
            <Button
              className="rounded-xl"
              disabled={updateFeed.isPending}
              onClick={handleSave}
            >
              {updateFeed.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              Save settings
            </Button>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
