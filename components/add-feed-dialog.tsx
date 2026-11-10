"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Compass, Download, Loader2, Rss } from "lucide-react";
import { SubscribeBookmarklet } from "@/components/subscribe-bookmarklet";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAddFeed, useCategories, useChangedetectionStatus, useImportOpml, useRsshubStatus } from "@/hooks/use-rss-data";
import { DEFAULT_STARTER_PACKS, starterPackToOpml, type StarterPack } from "@/lib/starter-packs";
import { cn } from "@/lib/utils";

// Lazy-loaded: only rendered inside the "Add feed → Discover" tab, so it doesn't
// need to be in the initial sidebar bundle.
const DiscoveryPanel = dynamic(
  () => import("@/components/discovery-panel").then((m) => m.DiscoveryPanel),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    ),
  },
);

// Lazy-loaded: only rendered inside the "Add feed → From web page" tab.
const PageFeedPanel = dynamic(
  () => import("@/components/page-feed-panel").then((m) => m.PageFeedPanel),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    ),
  },
);

// Lazy-loaded: only rendered inside the "Add feed → From platform" tab, which
// itself only renders once an admin has configured the RSSHub connector.
const RsshubPanel = dynamic(
  () => import("@/components/rsshub-panel").then((m) => m.RsshubPanel),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    ),
  },
);

// Lazy-loaded: only rendered inside the "Add feed → Monitor page" tab, which
// itself only renders once an admin has configured the changedetection.io connector.
const ChangedetectionPanel = dynamic(
  () => import("@/components/changedetection-panel").then((m) => m.ChangedetectionPanel),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    ),
  },
);

interface AddFeedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Feed URLs the user already follows (Discover marks them). */
  subscribedUrls: Set<string>;
  /** Share-target / bookmarklet URL: lands on "By URL" pre-filled. */
  initialUrl?: string;
  /** Bumped per open request, so a repeated share re-applies `initialUrl`. */
  requestId?: number;
}

/**
 * Add Feed dialog — a shell overlay (nav overlay "add-feed"), no longer
 * nested inside the feed sheet / sidebar: system Back closes it and it never
 * stacks on another overlay. Its form state resets on every close.
 */
export function AddFeedDialog({ open, onOpenChange, subscribedUrls, initialUrl, requestId = 0 }: AddFeedDialogProps) {
  const t = useTranslations();
  const locale = useLocale();
  const [newFeedUrl, setNewFeedUrl] = useState("");
  const [newFeedCategoryId, setNewFeedCategoryId] = useState<string>("none");
  const [isAddingFeed, setIsAddingFeed] = useState(false);
  const [discoveredFeeds, setDiscoveredFeeds] = useState<{ url: string; title: string; type: string; kind?: string }[]>([]);
  // "topic" = the input was a plain phrase; the list holds news/search feeds to pick from.
  const [discoveryMode, setDiscoveryMode] = useState<"url" | "topic">("url");
  const [discoveryMessage, setDiscoveryMessage] = useState<string | null>(null);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [importingPack, setImportingPack] = useState<string | null>(null);
  const [starterPacks, setStarterPacks] = useState<StarterPack[]>(DEFAULT_STARTER_PACKS);
  const [addingFeedUrl, setAddingFeedUrl] = useState<string | null>(null);
  const [addFeedTab, setAddFeedTab] = useState<"url" | "discover" | "more">("url");
  // Which specialized source is shown inside the consolidated "More sources" tab.
  const [moreSource, setMoreSource] = useState<"webpage" | "platform" | "monitor">("webpage");

  const addNewFeed = useAddFeed();
  const importOpml = useImportOpml();
  const { data: rsshubStatus } = useRsshubStatus();
  const rsshubConfigured = Boolean(rsshubStatus?.configured);
  const { data: changedetectionStatus } = useChangedetectionStatus();
  const changedetectionConfigured = Boolean(changedetectionStatus?.configured);
  // Specialized sources that live under the single "More sources" tab. "webpage"
  // is always available; the two optional connectors appear only once an admin
  // has configured them.
  const moreSources = useMemo(
    () =>
      [
        { value: "webpage" as const, label: t("sidebar.webpage.tabLabel") },
        ...(rsshubConfigured ? [{ value: "platform" as const, label: t("sidebar.rsshub.tabLabel") }] : []),
        ...(changedetectionConfigured ? [{ value: "monitor" as const, label: t("sidebar.changedetection.tabLabel") }] : []),
      ],
    [rsshubConfigured, changedetectionConfigured, t],
  );
  const { data: allCategories = [] } = useCategories();

  const loadStarterPacks = () => {
    fetch("/api/starter-packs")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data?.packs)) setStarterPacks(data.packs);
      })
      .catch(() => {});
  };

  // Starter packs load the first time the dialog opens (not with the shell).
  const packsLoaded = useRef(false);
  useEffect(() => {
    if (!open || packsLoaded.current) return;
    packsLoaded.current = true;
    loadStarterPacks();
  }, [open]);

  useEffect(() => {
    if (!open || !initialUrl) return;
    // Share-target / bookmarklet: land on "By URL" pre-filled. Discovery
    // runs only when the user presses it — a crafted `/?sharedUrl=` link
    // must not make the victim's session probe an attacker URL.
    setAddFeedTab("url");
    setMoreSource("webpage");
    setNewFeedUrl(initialUrl);
  }, [open, initialUrl, requestId]);

  // Every close path (X, Esc, scrim, cancel, success, system Back) resets the form.
  useEffect(() => {
    if (open) return;
    setDiscoveredFeeds([]);
    setDiscoveryMessage(null);
    setAddFeedTab("url");
  }, [open]);

  const handleDiscover = async (value: string = newFeedUrl) => {
    if (!value.trim()) return;
    setIsDiscovering(true);
    setDiscoveredFeeds([]);
    setDiscoveryMessage(null);
    try {
      const params = new URLSearchParams({ url: value.trim(), locale });
      const res = await fetch(`/api/discover?${params}`);
      const data = await res.json();
      const feeds = data.feeds || [];
      setDiscoveryMode(data.mode === "topic" ? "topic" : "url");
      setDiscoveredFeeds(feeds);
      if (feeds.length === 0) {
        const message = t("sidebar.resolverNoResult");
        setDiscoveryMessage(message);
        toast.info(message);
      }
    } catch {
      setDiscoveryMessage(t("sidebar.errors.discoveryFailedHint"));
      toast.error(t("sidebar.errors.discoveryFailedToast"));
    } finally {
      setIsDiscovering(false);
    }
  };


  const handleAddFeed = async (url: string, title?: string) => {
    setIsAddingFeed(true);
    setAddingFeedUrl(url);
    try {
      const result = await addNewFeed.mutateAsync({
        url,
        categoryId: newFeedCategoryId === "none" ? undefined : newFeedCategoryId,
      });
      if (!result?.success) {
        toast.error(result?.error || t("sidebar.errors.couldNotAdd"));
        return;
      }
      toast.success(t("sidebar.feedAdded", { name: result.feed?.name || title || "feed" }));
      if (addFeedTab === "discover") {
        return;
      }
      setNewFeedUrl("");
      setDiscoveredFeeds([]);
      setDiscoveryMessage(null);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("sidebar.errors.couldNotAdd"));
    } finally {
      setIsAddingFeed(false);
      setAddingFeedUrl(null);
    }
  };

  const handleImportStarterPack = async (pack: StarterPack) => {
    if (pack.feeds.length === 0 && !pack.path) {
      toast.error(t("sidebar.errors.packNoFeeds", { name: pack.name }));
      return;
    }
    setImportingPack(pack.id);
    try {
      let xml = "";
      if (pack.path && pack.feeds.length === 0) {
        const res = await fetch(`/starter-opml/${pack.path}`);
        if (!res.ok) throw new Error("Failed to fetch pack");
        xml = await res.text();
      } else {
        xml = starterPackToOpml(pack);
      }
      const result = await importOpml.mutateAsync(xml);
      const details = [
        result.feedsAdded ? t("sidebar.errors.feedsAdded", { count: result.feedsAdded }) : null,
        result.feedsUpdated ? t("sidebar.errors.feedsUpdated", { count: result.feedsUpdated }) : null,
      ].filter(Boolean).join(", ");
      if (!result.feedsAdded && !result.feedsUpdated) {
        toast.info(t("sidebar.errors.packNoNewFeeds", { name: pack.name }));
      } else if (details) {
        toast.success(t("sidebar.errors.packImportedWithDetails", { name: pack.name, details }));
      } else {
        toast.success(t("sidebar.errors.packImported", { name: pack.name }));
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(t("sidebar.errors.importFailedWithError", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setImportingPack(null);
    }
  };


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="rounded-2xl"
        style={{ width: "calc(100vw - 1rem)", maxWidth: "28rem" }}
      >
        <DialogHeader>
          <DialogTitle>{t("sidebar.addFeedTitle")}</DialogTitle>
        </DialogHeader>
        <Tabs value={addFeedTab} onValueChange={(v) => setAddFeedTab(v as "url" | "discover" | "more")} className="w-full min-w-0">
          {/* Always exactly three tabs: the everyday "by URL" path, browse &
              discover, and a single "More sources" bucket that holds the
              specialized paths (web page / platform / monitor) behind an
              inner selector — so the tab row never wraps regardless of which
              optional connectors are configured. */}
          <TabsList className="grid h-9 w-full grid-cols-3 rounded-xl">
            <TabsTrigger value="url" className="text-xs rounded-lg">{t("sidebar.byUrl")}</TabsTrigger>
            <TabsTrigger value="discover" className="text-xs rounded-lg">{t("sidebar.discover")}</TabsTrigger>
            <TabsTrigger value="more" className="text-xs rounded-lg">{t("sidebar.moreSources")}</TabsTrigger>
          </TabsList>

          {/* URL Tab */}
          <TabsContent value="url" className="mt-3 space-y-3">
            <div className="flex gap-1.5">
              <Input
                placeholder={t("sidebar.feedOrSiteUrl")}
                value={newFeedUrl}
                onChange={(e) => {
                  setNewFeedUrl(e.target.value);
                  setDiscoveredFeeds([]);
                  setDiscoveryMessage(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newFeedUrl) handleDiscover();
                }}
                className="h-9 text-sm flex-1"
              />
              <Button
                size="sm"
                variant="ghost"
                className="h-9 px-2 shrink-0"
                disabled={!newFeedUrl || isDiscovering}
                onClick={() => handleDiscover()}
                title={t("sidebar.findFeedsAtUrl")}
              >
                <Compass className={`w-4 h-4 ${isDiscovering ? "animate-spin" : ""}`} />
              </Button>
            </div>

            {discoveredFeeds.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground font-medium px-0.5">
                  {discoveryMode === "topic" ? t("sidebar.topicFeeds") : t("sidebar.foundFeeds")}
                </p>
                {discoveredFeeds.map((f) => (
                  <div key={f.url} className="flex items-center gap-1.5 rounded-xl bg-muted px-2 py-1.5">
                    <Rss className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs truncate flex-1 text-foreground" title={f.url}>{f.title}</span>
                    {f.kind && (
                      <span className="shrink-0 rounded-chip bg-background px-1.5 py-0.5 text-caption text-muted-foreground">
                        {t.has(`sidebar.kinds.${f.kind}`) ? t(`sidebar.kinds.${f.kind}`) : f.kind}
                      </span>
                    )}
                    <Button
                      size="sm"
                      className="h-6 px-2 text-xs shrink-0"
                      onClick={() => handleAddFeed(f.url, f.title)}
                      disabled={isAddingFeed}
                    >
                      {t("common.add")}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {discoveryMessage && discoveredFeeds.length === 0 && (
              <div className="rounded-xl border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
                {discoveryMessage}
              </div>
            )}

            <Select
              value={newFeedCategoryId}
              onValueChange={setNewFeedCategoryId}
            >
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder={t("sidebar.categoryPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("sidebar.noCategory")}</SelectItem>
                {allCategories.map((cat: any) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex gap-2">
              <Button
                size="sm"
                className="flex-1"
                disabled={!newFeedUrl || isAddingFeed}
                onClick={() => handleAddFeed(newFeedUrl)}
              >
                {t("sidebar.addDirectUrl")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="flex-1"
                onClick={() => {
                  onOpenChange(false);
                  setDiscoveredFeeds([]);
                  setDiscoveryMessage(null);
                }}
              >
                {t("common.cancel")}
              </Button>
            </div>
            <div className="border-t border-border/40 pt-3">
              <SubscribeBookmarklet />
            </div>
          </TabsContent>

          {/* Discover Tab — search + curated starter packs */}
          <TabsContent value="discover" className="mt-3 min-w-0 overflow-hidden">
            <div className="mb-3">
              <Select
                value={newFeedCategoryId}
                onValueChange={setNewFeedCategoryId}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder={t("sidebar.addToCategory")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("sidebar.noCategory")}</SelectItem>
                  {allCategories.map((cat: any) => (
                    <SelectItem key={cat.id} value={cat.id}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DiscoveryPanel
              onAddFeed={handleAddFeed}
              isAddingFeed={isAddingFeed}
              addingUrl={addingFeedUrl}
              subscribedUrls={subscribedUrls}
            />

            {/* Starter packs — moved here from the URL tab (they belong with
                "browse & discover", not the direct-add path). */}
            <div className="mt-4 pt-3 border-t border-border/40">
              <p className="text-xs text-muted-foreground font-medium mb-1.5">{t("sidebar.starterPacks")}</p>
              <div className="space-y-1">
                {starterPacks.map((pack) => (
                  <div key={pack.id} className="flex items-center gap-1.5 rounded-xl bg-muted px-2 py-1.5">
                    <span className="text-xs flex-1 text-foreground">
                      {pack.name}
                      <span className="text-muted-foreground ms-1">({pack.feeds.length || "OPML"})</span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs shrink-0"
                      disabled={importingPack === pack.id || (pack.feeds.length === 0 && !pack.path)}
                      onClick={() => handleImportStarterPack(pack)}
                    >
                      <Download className={cn("w-3 h-3 me-1", importingPack === pack.id && "animate-bounce")} />
                      {importingPack === pack.id ? t("sidebar.importing") : t("sidebar.import")}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>

          {/* More sources Tab — web page / platform / monitor behind a compact
              inner selector, plus one shared category picker. */}
          <TabsContent value="more" className="mt-3 min-w-0 overflow-hidden space-y-3">
            {moreSources.length > 1 && (
              <div className="grid w-full grid-cols-3 gap-1 rounded-xl bg-muted/60 p-1">
                {moreSources.map((src) => (
                  <button
                    key={src.value}
                    type="button"
                    onClick={() => setMoreSource(src.value)}
                    className={cn(
                      "rounded-lg px-2 py-1.5 text-xs font-medium transition-colors",
                      moreSource === src.value
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {src.label}
                  </button>
                ))}
              </div>
            )}

            <Select
              value={newFeedCategoryId}
              onValueChange={setNewFeedCategoryId}
            >
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder={t("sidebar.addToCategory")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("sidebar.noCategory")}</SelectItem>
                {allCategories.map((cat: any) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {moreSource === "webpage" && (
              <PageFeedPanel
                categoryId={newFeedCategoryId}
                initialUrl={initialUrl}
                onCreated={(feed) => {
                  toast.success(t("sidebar.webpage.feedCreated", { name: feed.name }));
                  onOpenChange(false);
                  setAddFeedTab("url");
                }}
              />
            )}
            {moreSource === "platform" && rsshubConfigured && (
              <RsshubPanel onAddFeed={handleAddFeed} isAddingFeed={isAddingFeed} />
            )}
            {moreSource === "monitor" && changedetectionConfigured && (
              <ChangedetectionPanel onAddFeed={handleAddFeed} isAddingFeed={isAddingFeed} />
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
