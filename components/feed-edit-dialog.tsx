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
import { Eye, Loader2 } from "lucide-react";
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
  const [previewUrl, setPreviewUrl] = useState("");
  const [activeTab, setActiveTab] = useState("auth");
  const [previewResult, setPreviewResult] = useState<{
    html: string;
    charCount: number;
    selectorUsed: string;
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
                { value: "fulltext", label: "Full-Text" },
                { value: "freshrss", label: "FreshRSS" },
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
                    <div
                      className="max-h-48 overflow-y-auto rounded-xl bg-background/80 p-3 text-sm prose prose-sm dark:prose-invert max-w-none"
                      dangerouslySetInnerHTML={{ __html: previewResult.html.slice(0, 10_000) }}
                    />
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="freshrss" className="mt-0 space-y-5">
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
                <p className="text-xs text-muted-foreground">Stores FreshRSS XPath / JSON DotNotation settings imported from OPML.</p>
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
                  placeholder="FreshRSS cssFullContentConditions, one per line"
                  className="min-h-20 rounded-xl border-border/70 bg-background/70 font-mono text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Auto-read filters</Label>
                <Textarea
                  value={filtersActionRead}
                  onChange={(e) => setFiltersActionRead(e.target.value)}
                  placeholder="FreshRSS filtersActionRead, one per line"
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
