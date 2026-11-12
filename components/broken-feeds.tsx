"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Archive, BellOff, CheckCircle2, Loader2, Pencil, RefreshCw, Trash2, Wrench } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { ChipLabel } from "@/components/ui/chip";
import { Empty, EmptyContent, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InactiveFeeds } from "@/components/inactive-feeds";
import { FeedFavicon } from "@/components/list/feed-favicon";
import {
  applyFeedRepair,
  archiveFeeds,
  proposeFeedRepair,
  restoreFeeds,
  removeStaleBrokenFeeds,
  retestBrokenFeed,
  unmuteBrokenFeed,
  type BrokenFeedDto,
  type RepairProposal,
} from "@/app/actions/broken-feeds";
import { BROKEN_FEEDS_KEY, invalidateFeedLists, useBrokenFeeds, useInactiveFeeds } from "@/hooks/use-broken-feeds";
import { useDeleteFeed, useFeeds } from "@/hooks/use-rss-data";
import { cn } from "@/lib/utils";

/** Feeds re-tested at once by "Alle erneut testen" (each one is a real fetch). */
const BULK_CONCURRENCY = 3;

type Busy = "test" | "unmute" | "repair" | "apply" | "remove" | "archive";
type Notice = { tone: "error" | "info"; text: string };
type RepairState = { feedId: string; loading: boolean; proposal: RepairProposal | null; failed: boolean; applying: string | null };

/**
 * "Defekte Feeds": two groups with different remedies. "Kaputt" = the fetch fails (HTTP 4xx/5xx, DNS, parse,
 * blocked); "Inaktiv" = the fetch works but nothing new was published for a long time. Both can be archived.
 */
export function BrokenFeeds({ onEdit }: { onEdit: (feed: any) => void }) {
  const t = useTranslations("brokenFeeds");
  const [group, setGroup] = useState<"broken" | "inactive">("broken");
  const { data: brokenFeeds } = useBrokenFeeds();
  const { data: inactive } = useInactiveFeeds();
  const brokenCount = brokenFeeds?.length;
  const inactiveCount = inactive?.feeds.length;
  return (
    <div className="flex h-full flex-col" data-testid="feed-health-groups">
      <Tabs value={group} onValueChange={(v) => setGroup(v === "inactive" ? "inactive" : "broken")} className="px-6 pt-4 sm:px-8">
        <TabsList aria-label={t("groups.label")}>
          <TabsTrigger value="broken" data-testid="health-group-broken">
            {brokenCount === undefined ? t("groups.broken") : t("groups.brokenCount", { count: brokenCount })}
          </TabsTrigger>
          <TabsTrigger value="inactive" data-testid="health-group-inactive">
            {inactiveCount === undefined ? t("groups.inactive") : t("groups.inactiveCount", { count: inactiveCount })}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="min-h-0 flex-1">{group === "broken" ? <BrokenList onEdit={onEdit} /> : <InactiveFeeds onEdit={onEdit} />}</div>
    </div>
  );
}

function BrokenList({ onEdit }: { onEdit: (feed: any) => void }) {
  const t = useTranslations("brokenFeeds");
  const format = useFormatter();
  const queryClient = useQueryClient();
  const { data: allFeeds = [], dataUpdatedAt: feedsUpdatedAt } = useFeeds();
  const { data: feeds = [], isLoading, isError, refetch } = useBrokenFeeds();
  const deleteFeed = useDeleteFeed();

  const [busy, setBusy] = useState<Record<string, Busy>>({});
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const [repair, setRepair] = useState<RepairState | null>(null);
  const [pendingRemove, setPendingRemove] = useState<BrokenFeedDto | null>(null);
  const [confirmStale, setConfirmStale] = useState(false);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const cancelBulk = useRef(false);

  // The edit dialog saves through the shared feed list: re-read the triage list when it changed.
  const firstFeedsUpdate = useRef(feedsUpdatedAt);
  useEffect(() => {
    if (feedsUpdatedAt !== firstFeedsUpdate.current) void queryClient.invalidateQueries({ queryKey: BROKEN_FEEDS_KEY });
  }, [feedsUpdatedAt, queryClient]);

  const staleFeeds = useMemo(() => feeds.filter((f) => f.stale), [feeds]);
  const mutedCount = useMemo(() => feeds.filter((f) => f.autoMuted).length, [feeds]);

  const setBusyFor = useCallback((id: string, value: Busy | null) => {
    setBusy((prev) => {
      const next = { ...prev };
      if (value) next[id] = value;
      else delete next[id];
      return next;
    });
  }, []);
  const setNotice = useCallback((id: string, notice: Notice | null) => {
    setNotices((prev) => {
      const next = { ...prev };
      if (notice) next[id] = notice;
      else delete next[id];
      return next;
    });
  }, []);

  const patchList = useCallback(
    (id: string, replacement: BrokenFeedDto | null) => {
      queryClient.setQueryData<BrokenFeedDto[]>(BROKEN_FEEDS_KEY, (old = []) =>
        replacement ? old.map((f) => (f.id === id ? replacement : f)) : old.filter((f) => f.id !== id),
      );
    },
    [queryClient],
  );
  const refreshShell = useCallback(() => invalidateFeedLists(queryClient), [queryClient]);

  const categoryLabel = (feed: BrokenFeedDto) => t(`categories.${feed.category}`);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium" });

  /** Re-tests one feed through the normal sync path. Returns whether it recovered (null = could not run). */
  const retest = useCallback(
    async (feed: BrokenFeedDto, quiet = false): Promise<boolean | null> => {
      setBusyFor(feed.id, "test");
      setNotice(feed.id, null);
      try {
        const result = await retestBrokenFeed(feed.id);
        if (result.status === "rate-limited") {
          const text = t("retest.rateLimited", { seconds: result.retryAfterSecs });
          setNotice(feed.id, { tone: "error", text });
          if (!quiet) toast.error(text);
          return null;
        }
        if (result.status === "recovered") {
          patchList(feed.id, null);
          if (!quiet) toast.success(t("retest.recovered", { name: feed.name }));
          return true;
        }
        if (result.feed) patchList(feed.id, result.feed);
        else patchList(feed.id, null);
        const category = result.feed ? categoryLabel(result.feed) : categoryLabel(feed);
        setNotice(feed.id, { tone: "error", text: t("retest.stillBroken", { category }) });
        return false;
      } catch {
        setNotice(feed.id, { tone: "error", text: t("retest.failed") });
        return null;
      } finally {
        setBusyFor(feed.id, null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- categoryLabel only closes over `t`
    [patchList, setBusyFor, setNotice, t],
  );

  const retestOne = async (feed: BrokenFeedDto) => {
    await retest(feed);
    refreshShell();
  };

  const retestAll = async () => {
    const queue = [...feeds];
    const total = queue.length;
    if (total === 0) return;
    cancelBulk.current = false;
    setBulk({ done: 0, total });
    let recovered = 0;
    let failed = 0;
    let done = 0;
    let stopped = false;
    const worker = async () => {
      for (;;) {
        if (cancelBulk.current || stopped) return;
        const next = queue.shift();
        if (!next) return;
        const ok = await retest(next, true);
        if (ok === true) recovered++;
        else if (ok === false) failed++;
        else stopped = true; // rate limit / server error: stop instead of hammering
        done++;
        setBulk({ done, total });
      }
    };
    await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, total) }, worker));
    setBulk(null);
    refreshShell();
    toast(t("bulk.retestDone", { recovered, failed }));
  };

  const unmute = async (feed: BrokenFeedDto) => {
    setBusyFor(feed.id, "unmute");
    try {
      await unmuteBrokenFeed(feed.id);
      toast.success(t("unmuted", { name: feed.name }));
      patchList(feed.id, { ...feed, autoMuted: false, consecutiveFailureCount: 0, failingSince: null, stale: false });
      await refetch();
      refreshShell();
    } catch {
      toast.error(t("unmuteFailed"));
    } finally {
      setBusyFor(feed.id, null);
    }
  };

  const openRepair = async (feed: BrokenFeedDto) => {
    setRepair({ feedId: feed.id, loading: true, proposal: null, failed: false, applying: null });
    setBusyFor(feed.id, "repair");
    try {
      const proposal = await proposeFeedRepair(feed.id);
      setRepair({ feedId: feed.id, loading: false, proposal, failed: false, applying: null });
    } catch {
      setRepair({ feedId: feed.id, loading: false, proposal: null, failed: true, applying: null });
    } finally {
      setBusyFor(feed.id, null);
    }
  };

  const applyRepair = async (feed: BrokenFeedDto, url: string) => {
    setRepair((r) => (r ? { ...r, applying: url } : r));
    try {
      const result = await applyFeedRepair(feed.id, url);
      if (!result.success) {
        toast.error(t(`repair.errors.${result.error}`));
        setRepair((r) => (r ? { ...r, applying: null } : r));
        return;
      }
      if (result.recovered) {
        toast.success(t("repair.applied", { name: feed.name }));
        patchList(feed.id, null);
      } else {
        toast(t("repair.appliedStillBroken"));
        if (result.feed) patchList(feed.id, result.feed);
      }
      setRepair(null);
      refreshShell();
    } catch {
      toast.error(t("repair.failed"));
      setRepair((r) => (r ? { ...r, applying: null } : r));
    }
  };

  const confirmRemove = () => {
    const feed = pendingRemove;
    setPendingRemove(null);
    if (!feed) return;
    setBusyFor(feed.id, "remove");
    deleteFeed.mutate(feed.id, {
      onSuccess: () => {
        toast.success(t("removed", { name: feed.name }));
        patchList(feed.id, null);
        refreshShell();
      },
      onError: () => toast.error(t("removeFailed")),
      onSettled: () => setBusyFor(feed.id, null),
    });
  };

  const archive = async (feed: BrokenFeedDto) => {
    setBusyFor(feed.id, "archive");
    try {
      await archiveFeeds([feed.id]);
      patchList(feed.id, null);
      refreshShell();
      toast.success(t("archive.done", { name: feed.name }), {
        action: {
          label: t("archive.undo"),
          onClick: () => void restoreFeeds([feed.id]).then(refreshShell, () => toast.error(t("archive.failed"))),
        },
      });
    } catch {
      toast.error(t("archive.failed"));
    } finally {
      setBusyFor(feed.id, null);
    }
  };

  const removeStale = async () => {
    setConfirmStale(false);
    try {
      const { removed } = await removeStaleBrokenFeeds(staleFeeds.map((f) => f.id));
      toast.success(t("bulk.removeStaleDone", { count: removed }));
      await refetch();
      refreshShell();
    } catch {
      toast.error(t("bulk.removeStaleFailed"));
    }
  };

  const edit = (feed: BrokenFeedDto) => {
    const full = (allFeeds as any[]).find((f) => f.id === feed.id);
    if (full) onEdit(full);
  };

  const bulkRunning = bulk !== null;

  return (
    <div className="flex h-full flex-col px-6 py-4 sm:px-8" data-testid="broken-feeds">
      <div className="mb-4 flex flex-col gap-3 rounded-panel border border-border/60 bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="font-semibold tracking-title">{t("title")}</h3>
          <p className="text-body-sm text-muted-foreground">{t("description")}</p>
          {feeds.length > 0 && (
            <p className="mt-1 text-footnote text-muted-foreground" data-testid="broken-feeds-summary">
              {t("summary", { count: feeds.length })}
              {mutedCount > 0 ? ` · ${t("summaryMuted", { count: mutedCount })}` : ""}
            </p>
          )}
        </div>
        {feeds.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="rounded-panel"
              onClick={() => void retestAll()}
              disabled={bulkRunning}
              data-testid="broken-retest-all"
            >
              <RefreshCw className={cn("me-1.5 size-3.5", bulkRunning && "animate-spin")} aria-hidden />
              {t("bulk.retestAll")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-panel text-destructive"
              onClick={() => setConfirmStale(true)}
              disabled={staleFeeds.length === 0 || bulkRunning}
              title={t("bulk.removeStale")}
              data-testid="broken-remove-stale"
            >
              <Trash2 className="me-1.5 size-3.5" aria-hidden />
              {t("bulk.removeStaleCount", { count: staleFeeds.length })}
            </Button>
          </div>
        )}
      </div>

      {bulk && (
        <div className="mb-4 rounded-panel border border-border/60 bg-card p-3" role="status" data-testid="broken-bulk-progress">
          <div className="mb-2 flex items-center justify-between gap-3 text-body-sm">
            <span>{t("bulk.retestProgress", { done: bulk.done, total: bulk.total })}</span>
            <Button size="sm" variant="ghost" onClick={() => (cancelBulk.current = true)}>
              {t("bulk.cancel")}
            </Button>
          </div>
          <Progress value={bulk.total ? Math.round((bulk.done / bulk.total) * 100) : 0} aria-label={t("bulk.retestAll")} />
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-8 pe-3">
          {isError ? (
            <Empty className="border-0 py-10">
              <EmptyMedia variant="icon">
                <AlertTriangle className="size-6" />
              </EmptyMedia>
              <EmptyContent>
                <EmptyTitle>{t("loadError")}</EmptyTitle>
                <Button size="sm" className="mt-3" onClick={() => void refetch()}>
                  {t("retry")}
                </Button>
              </EmptyContent>
            </Empty>
          ) : isLoading ? (
            <div className="flex justify-center py-10 text-muted-foreground" role="status">
              <Loader2 className="size-5 animate-spin" aria-hidden />
            </div>
          ) : feeds.length === 0 ? (
            <Empty className="border-0 py-10" data-testid="broken-feeds-empty">
              <EmptyMedia variant="icon">
                <CheckCircle2 className="size-6" />
              </EmptyMedia>
              <EmptyContent>
                <EmptyTitle>{t("empty")}</EmptyTitle>
                <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
              </EmptyContent>
            </Empty>
          ) : (
            <ul className="space-y-3">
              {feeds.map((feed) => {
                const state = busy[feed.id];
                const notice = notices[feed.id];
                const repairing = repair?.feedId === feed.id ? repair : null;
                return (
                  <li
                    key={feed.id}
                    className="rounded-panel border border-border/60 bg-card p-4"
                    data-testid="broken-feed"
                    data-feed-name={feed.name}
                  >
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center">
                        <FeedFavicon icon={feed.icon} name={feed.name} size={24} articleLink={feed.host ? `https://${feed.host}` : undefined} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <h4 className="truncate font-semibold tracking-subtitle">{feed.name}</h4>
                          {feed.autoMuted && (
                            <ChipLabel tone="warning" data-testid="broken-muted">
                              <BellOff className="size-2.5" aria-hidden />
                              {t("muted")}
                            </ChipLabel>
                          )}
                        </div>
                        <p className="truncate text-footnote text-muted-foreground">{feed.host || "—"}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <p className="text-body-sm font-medium text-destructive" data-testid="broken-category">
                            {categoryLabel(feed)}
                          </p>
                          {feed.kind !== "error" && (
                            <ChipLabel tone={feed.kind === "blocked" ? "warning" : "muted"} data-testid="broken-kind" data-kind={feed.kind}>
                              {t(`kinds.${feed.kind}`)}
                            </ChipLabel>
                          )}
                        </div>
                        {feed.kind === "blocked" && (
                          <p className="mt-1 text-footnote text-muted-foreground" data-testid="broken-kind-hint">
                            {t("kindHints.blocked")}
                          </p>
                        )}
                        {feed.kind === "gone" && (
                          <p className="mt-1 text-footnote text-muted-foreground" data-testid="broken-kind-hint">
                            {t("kindHints.gone")}
                          </p>
                        )}
                        {feed.detail && (
                          <details className="mt-1 text-footnote text-muted-foreground">
                            <summary className="cursor-pointer select-none">{t("technicalDetail")}</summary>
                            <p className="mt-1 break-words rounded-panel bg-muted/50 px-2 py-1.5 font-mono">{feed.detail}</p>
                          </details>
                        )}
                        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-footnote text-muted-foreground">
                          <span>{t("failures", { count: feed.consecutiveFailureCount })}</span>
                          <span>{feed.failingSince ? t("failingSince", { date: date(feed.failingSince) }) : t("failingSinceUnknown")}</span>
                          <span>{feed.lastSuccessAt ? t("lastSuccess", { date: date(feed.lastSuccessAt) }) : t("lastSuccessUnknown")}</span>
                        </p>
                        {notice && (
                          <p
                            role="status"
                            className={cn("mt-2 text-footnote", notice.tone === "error" ? "text-destructive" : "text-muted-foreground")}
                            data-testid="broken-notice"
                          >
                            {notice.text}
                          </p>
                        )}

                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-panel"
                            onClick={() => void retestOne(feed)}
                            disabled={!!state || bulkRunning}
                            data-testid="broken-retest"
                          >
                            {state === "test" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
                            {state === "test" ? t("actions.retesting") : t("actions.retest")}
                          </Button>
                          {feed.canRepair && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="rounded-panel"
                              onClick={() => void openRepair(feed)}
                              disabled={!!state || bulkRunning}
                              data-testid="broken-repair"
                            >
                              <Wrench className="size-3.5" aria-hidden />
                              {t("actions.repair")}
                            </Button>
                          )}
                          <Button size="sm" variant="outline" className="rounded-panel" onClick={() => edit(feed)} disabled={!!state} data-testid="broken-edit">
                            <Pencil className="size-3.5" aria-hidden />
                            {t("actions.edit")}
                          </Button>
                          {feed.autoMuted && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="rounded-panel"
                              onClick={() => void unmute(feed)}
                              disabled={!!state || bulkRunning}
                              data-testid="broken-unmute"
                            >
                              <BellOff className="size-3.5" aria-hidden />
                              {t("actions.unmute")}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-panel"
                            onClick={() => void archive(feed)}
                            disabled={!!state || bulkRunning}
                            title={t("archive.hint")}
                            data-testid="broken-archive"
                          >
                            {state === "archive" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Archive className="size-3.5" aria-hidden />}
                            {t("actions.archive")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-panel text-destructive"
                            onClick={() => setPendingRemove(feed)}
                            disabled={!!state || bulkRunning}
                            data-testid="broken-remove"
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                            {t("actions.remove")}
                          </Button>
                        </div>

                        {repairing && (
                          <div className="mt-3 rounded-panel border border-border/60 bg-background p-3" data-testid="broken-repair-panel">
                            <p className="text-body-sm font-medium">{t("repair.title", { name: feed.name })}</p>
                            {repairing.loading ? (
                              <p className="mt-2 flex items-center gap-2 text-footnote text-muted-foreground" role="status">
                                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                                {t("repair.searching", { site: feed.host })}
                              </p>
                            ) : repairing.failed ? (
                              <p className="mt-2 text-footnote text-destructive">{t("repair.failed")}</p>
                            ) : repairing.proposal?.status === "rate-limited" ? (
                              <p className="mt-2 text-footnote text-muted-foreground">{t("repair.rateLimited")}</p>
                            ) : repairing.proposal?.status === "unsupported" ? (
                              <p className="mt-2 text-footnote text-muted-foreground">{t("repair.unsupported")}</p>
                            ) : repairing.proposal?.status === "ok" && repairing.proposal.candidates.length > 0 ? (
                              <ul className="mt-2 space-y-2">
                                {repairing.proposal.candidates.map((candidate) => (
                                  <li key={candidate.url} className="flex items-center gap-3" data-testid="broken-repair-candidate">
                                    <div className="min-w-0 flex-1">
                                      <p className="truncate text-body-sm">{candidate.title || candidate.url}</p>
                                      <p className="truncate text-footnote text-muted-foreground">{candidate.url}</p>
                                    </div>
                                    <Button
                                      size="sm"
                                      className="rounded-panel"
                                      onClick={() => void applyRepair(feed, candidate.url)}
                                      disabled={repairing.applying !== null}
                                    >
                                      {repairing.applying === candidate.url && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                                      {t("repair.use")}
                                    </Button>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="mt-2 text-footnote text-muted-foreground" data-testid="broken-repair-none">
                                {t("repair.none")}
                                {repairing.proposal?.status === "ok" && repairing.proposal.hint
                                  ? ` ${t(`repair.noneHint.${repairing.proposal.hint}`)}`
                                  : ""}
                              </p>
                            )}
                            <div className="mt-2">
                              <Button size="sm" variant="ghost" onClick={() => setRepair(null)}>
                                {t("repair.close")}
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </ScrollArea>

      <AlertDialog open={pendingRemove !== null} onOpenChange={(o) => !o && setPendingRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeTitle", { name: pendingRemove?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("removeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmRemove}
              data-testid="broken-remove-confirm"
            >
              {t("removeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmStale} onOpenChange={setConfirmStale}>
        <AlertDialogContent data-testid="broken-remove-stale-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("bulk.removeStaleTitle", { count: staleFeeds.length })}</AlertDialogTitle>
            <AlertDialogDescription>{t("bulk.removeStaleDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void removeStale()}
            >
              {t("bulk.removeStaleConfirm", { count: staleFeeds.length })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
