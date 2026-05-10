"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
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
  const [autoFetchFullText, setAutoFetchFullText] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewResult, setPreviewResult] = useState<{
    html: string;
    charCount: number;
    selectorUsed: string;
  } | null>(null);

  useEffect(() => {
    if (!feed) return;
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
    setAutoFetchFullText(feed.autoFetchFullText ?? false);
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
          autoFetchFullText,
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
      <DialogContent className="max-w-2xl rounded-[2rem] border border-border/70 bg-background p-0 shadow-2xl">
        <DialogHeader className="border-b border-border/60 bg-card/95 px-8 py-6 backdrop-blur-2xl">
          <DialogTitle className="text-2xl font-semibold tracking-[-0.04em]">
            {feed.name}
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground truncate">
            {feed.url}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="auth" className="flex flex-col">
          <div className="px-8 pt-4">
            <TabsList className="bg-muted/45 p-1 rounded-2xl w-fit border border-border/60">
              <TabsTrigger value="auth" className="rounded-xl px-5 py-2 data-[state=active]:bg-background data-[state=active]:shadow-sm text-sm">
                Authentication
              </TabsTrigger>
              <TabsTrigger value="fetch" className="rounded-xl px-5 py-2 data-[state=active]:bg-background data-[state=active]:shadow-sm text-sm">
                Fetch Options
              </TabsTrigger>
              <TabsTrigger value="fulltext" className="rounded-xl px-5 py-2 data-[state=active]:bg-background data-[state=active]:shadow-sm text-sm">
                Full-Text
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="px-8 py-6 space-y-5">
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

              <div className="grid grid-cols-2 gap-4">
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
                <div className="flex gap-2">
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
          </div>

          <div className="flex justify-end gap-2 border-t border-border/60 px-8 py-4">
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
