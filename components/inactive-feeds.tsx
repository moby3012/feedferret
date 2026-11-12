"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Archive, CheckCircle2, Loader2, Pencil } from "lucide-react";
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
import { Empty, EmptyContent, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FeedFavicon } from "@/components/list/feed-favicon";
import { archiveFeeds, archiveInactiveFeeds, restoreFeeds, type InactiveFeedDto } from "@/app/actions/broken-feeds";
import { INACTIVE_FEEDS_KEY, invalidateFeedLists, useInactiveFeeds } from "@/hooks/use-broken-feeds";
import { useFeeds, useUpdateGlobalSettings } from "@/hooks/use-rss-data";
import { DEFAULT_INACTIVE_FEED_DAYS } from "@/lib/broken-feeds";

/** Thresholds offered in the picker; the user's current value is added when it is not one of them. */
const THRESHOLD_CHOICES = [30, 90, 180, 365, 730] as const;

/**
 * "Inaktiv": feeds that are fetched without errors but whose newest item is older than the user's threshold
 * (`inactiveFeedDays`, default 180). Nothing is wrong with them, so the remedy is not repair but archiving:
 * the feed stops syncing and leaves the sidebar / counts, its articles stay.
 */
export function InactiveFeeds({ onEdit }: { onEdit: (feed: any) => void }) {
  const t = useTranslations("brokenFeeds.inactive");
  const tb = useTranslations("brokenFeeds");
  const format = useFormatter();
  const queryClient = useQueryClient();
  const { data: allFeeds = [], dataUpdatedAt: feedsUpdatedAt } = useFeeds();
  const { data, isLoading, isError, refetch } = useInactiveFeeds();
  const updateSettings = useUpdateGlobalSettings();
  const feeds = useMemo(() => data?.feeds ?? [], [data]);
  const thresholdDays = data?.thresholdDays ?? DEFAULT_INACTIVE_FEED_DAYS;

  const [busy, setBusy] = useState<Record<string, true>>({});
  const [confirmAll, setConfirmAll] = useState(false);
  const [archivingAll, setArchivingAll] = useState(false);

  // The edit dialog saves through the shared feed list: re-read when it changed.
  const firstFeedsUpdate = useRef(feedsUpdatedAt);
  useEffect(() => {
    if (feedsUpdatedAt !== firstFeedsUpdate.current) void queryClient.invalidateQueries({ queryKey: INACTIVE_FEEDS_KEY });
  }, [feedsUpdatedAt, queryClient]);

  const choices = useMemo(
    () => [...new Set<number>([...THRESHOLD_CHOICES, thresholdDays])].sort((a, b) => a - b),
    [thresholdDays],
  );
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium" });

  const refreshShell = useCallback(() => invalidateFeedLists(queryClient), [queryClient]);

  const setThreshold = (value: string) => {
    const days = Number(value);
    if (!Number.isFinite(days) || days === thresholdDays) return;
    updateSettings.mutate(
      { inactiveFeedDays: days },
      {
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: INACTIVE_FEEDS_KEY }),
        onError: () => toast.error(t("thresholdFailed")),
      },
    );
  };

  const patchList = useCallback(
    (ids: string[]) => {
      const gone = new Set(ids);
      queryClient.setQueryData<{ thresholdDays: number; feeds: InactiveFeedDto[] }>(INACTIVE_FEEDS_KEY, (old) =>
        old ? { ...old, feeds: old.feeds.filter((f) => !gone.has(f.id)) } : old,
      );
    },
    [queryClient],
  );

  const archiveOne = async (feed: InactiveFeedDto) => {
    setBusy((prev) => ({ ...prev, [feed.id]: true }));
    try {
      const { archivedIds } = await archiveFeeds([feed.id]);
      patchList([feed.id]);
      refreshShell();
      toast.success(tb("archive.done", { name: feed.name }), {
        action: {
          label: tb("archive.undo"),
          onClick: () => void restoreFeeds(archivedIds).then(refreshShell, () => toast.error(tb("archive.failed"))),
        },
      });
    } catch {
      toast.error(tb("archive.failed"));
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[feed.id];
        return next;
      });
    }
  };

  const archiveAll = async () => {
    setConfirmAll(false);
    const ids = feeds.map((f) => f.id);
    if (ids.length === 0) return;
    setArchivingAll(true);
    try {
      const { archived, archivedIds } = await archiveInactiveFeeds(ids);
      // Undo restores exactly what this click archived (feeds that stopped matching in between were skipped).
      toast.success(t("archiveAllDone", { count: archived }), {
        action: {
          label: tb("archive.undo"),
          onClick: () => void restoreFeeds(archivedIds).then(refreshShell, () => toast.error(tb("archive.failed"))),
        },
      });
      await refetch();
      refreshShell();
    } catch {
      toast.error(t("archiveAllFailed"));
    } finally {
      setArchivingAll(false);
    }
  };

  const edit = (feed: InactiveFeedDto) => {
    const full = (allFeeds as any[]).find((f) => f.id === feed.id);
    if (full) onEdit(full);
  };

  return (
    <div className="flex h-full flex-col px-6 py-4 sm:px-8" data-testid="inactive-feeds">
      <div className="mb-4 flex flex-col gap-3 rounded-panel border border-border/60 bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="font-semibold tracking-title">{t("title")}</h3>
          <p className="text-body-sm text-muted-foreground">{t("description", { days: thresholdDays })}</p>
          {feeds.length > 0 && (
            <p className="mt-1 text-footnote text-muted-foreground" data-testid="inactive-feeds-summary">
              {t("summary", { count: feeds.length })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(thresholdDays)} onValueChange={setThreshold}>
            <SelectTrigger className="h-9 w-44 rounded-panel border-border/70 bg-background/70 text-footnote" aria-label={t("threshold")} data-testid="inactive-threshold">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {t("thresholdOption", { days })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {feeds.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="rounded-panel"
              onClick={() => setConfirmAll(true)}
              disabled={archivingAll}
              data-testid="inactive-archive-all"
            >
              {archivingAll ? <Loader2 className="me-1.5 size-3.5 animate-spin" aria-hidden /> : <Archive className="me-1.5 size-3.5" aria-hidden />}
              {t("archiveAll", { count: feeds.length })}
            </Button>
          )}
        </div>
      </div>

      <span id="inactive-archive-hint" className="sr-only">
        {tb("archive.hint")}
      </span>
      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-8 pe-3">
          {isError ? (
            <Empty className="border-0 py-10">
              <EmptyMedia variant="icon">
                <AlertTriangle className="size-6" />
              </EmptyMedia>
              <EmptyContent>
                <EmptyTitle>{tb("loadError")}</EmptyTitle>
                <Button size="sm" className="mt-3" onClick={() => void refetch()}>
                  {tb("retry")}
                </Button>
              </EmptyContent>
            </Empty>
          ) : isLoading ? (
            <div className="flex justify-center py-10 text-muted-foreground" role="status">
              <Loader2 className="size-5 animate-spin" aria-hidden />
            </div>
          ) : feeds.length === 0 ? (
            <Empty className="border-0 py-10" data-testid="inactive-feeds-empty">
              <EmptyMedia variant="icon">
                <CheckCircle2 className="size-6" />
              </EmptyMedia>
              <EmptyContent>
                <EmptyTitle>{t("empty")}</EmptyTitle>
                <EmptyDescription>{t("emptyDescription", { days: thresholdDays })}</EmptyDescription>
              </EmptyContent>
            </Empty>
          ) : (
            <ul className="space-y-3">
              {feeds.map((feed) => (
                <li key={feed.id} className="rounded-panel border border-border/60 bg-card p-4" data-testid="inactive-feed" data-feed-name={feed.name}>
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center">
                      <FeedFavicon icon={feed.icon} name={feed.name} size={24} articleLink={feed.host ? `https://${feed.host}` : undefined} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h4 className="truncate font-semibold tracking-subtitle">{feed.name}</h4>
                      <p className="truncate text-footnote text-muted-foreground">{feed.host || "—"}</p>
                      <p className="mt-2 text-body-sm font-medium" data-testid="inactive-reason">
                        {feed.lastItemAt
                          ? t("lastItem", { date: date(feed.lastItemAt), days: feed.inactiveDays })
                          : t("neverPublished", { days: feed.inactiveDays })}
                      </p>
                      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-footnote text-muted-foreground">
                        <span>{t("articles", { count: feed.articleCount })}</span>
                        <span>{feed.lastSuccessAt ? tb("lastSuccess", { date: date(feed.lastSuccessAt) }) : tb("lastSuccessUnknown")}</span>
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="rounded-panel"
                          onClick={() => void archiveOne(feed)}
                          disabled={!!busy[feed.id] || archivingAll}
                          title={tb("archive.hint")}
                          aria-describedby="inactive-archive-hint"
                          data-testid="inactive-archive"
                        >
                          {busy[feed.id] ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Archive className="size-3.5" aria-hidden />}
                          {tb("actions.archive")}
                        </Button>
                        <Button size="sm" variant="outline" className="rounded-panel" onClick={() => edit(feed)} disabled={!!busy[feed.id]} data-testid="inactive-edit">
                          <Pencil className="size-3.5" aria-hidden />
                          {tb("actions.edit")}
                        </Button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </ScrollArea>

      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent data-testid="inactive-archive-all-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("archiveAllTitle", { count: feeds.length })}</AlertDialogTitle>
            <AlertDialogDescription>{t("archiveAllDescription", { days: thresholdDays })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tb("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void archiveAll()} data-testid="inactive-archive-all-confirm-button">
              {t("archiveAllConfirm", { count: feeds.length })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
