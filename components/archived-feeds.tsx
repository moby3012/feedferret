"use client";

import { useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { FeedFavicon } from "@/components/list/feed-favicon";
import { restoreFeeds } from "@/app/actions/broken-feeds";
import { invalidateFeedLists, useArchivedFeeds } from "@/hooks/use-broken-feeds";
import { feedHost } from "@/lib/broken-feeds";

/**
 * Manage feeds → Feeds → "Archiviert": feeds that stopped syncing and left the sidebar. Their articles are
 * still there (open them through the feed's own view, or find them with search); "Wiederherstellen" resumes syncing.
 */
export function ArchivedFeeds() {
  const t = useTranslations("feedManagement.feeds");
  const format = useFormatter();
  const queryClient = useQueryClient();
  const { data: archived = [], isLoading } = useArchivedFeeds();
  const [busy, setBusy] = useState<string | null>(null);

  const restore = async (feed: { id: string; name: string }) => {
    setBusy(feed.id);
    try {
      await restoreFeeds([feed.id]);
      toast.success(t("restored", { name: feed.name }));
      invalidateFeedLists(queryClient);
    } catch {
      toast.error(t("restoreFailed"));
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground" role="status">
        <Loader2 className="size-5 animate-spin" aria-hidden />
      </div>
    );
  }
  if (archived.length === 0) {
    return (
      <Empty className="my-4 border-0" data-testid="archived-feeds-empty">
        <EmptyMedia variant="icon"><Archive className="size-5" /></EmptyMedia>
        <EmptyContent>
          <EmptyTitle>{t("archivedEmpty")}</EmptyTitle>
          <EmptyDescription>{t("archivedEmptyDescription")}</EmptyDescription>
        </EmptyContent>
      </Empty>
    );
  }
  return (
    <ul className="space-y-2" data-testid="archived-feeds">
      {archived.map((feed: any) => (
        <li
          key={feed.id}
          id={`feed-row-${feed.id}`}
          className="flex flex-col gap-3 rounded-panel border border-border/60 bg-card p-3.5 sm:flex-row sm:items-center"
          data-testid="archived-feed"
          data-feed-name={feed.name}
        >
          <div className="flex min-w-0 items-start gap-3 sm:flex-1">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center">
              <FeedFavicon icon={feed.icon} name={feed.name} size={24} articleLink={feedHost(feed.url) ? `https://${feedHost(feed.url)}` : undefined} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold tracking-subtitle text-body-sm text-foreground">{feed.name}</div>
              <div className="truncate text-footnote text-muted-foreground">{feedHost(feed.url) || "—"}</div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-footnote text-muted-foreground">
                {feed.archivedAt && <span>{t("archivedOn", { date: format.dateTime(new Date(feed.archivedAt), { dateStyle: "medium" }) })}</span>}
                <span>{t("archivedArticles", { count: feed.articleCount ?? 0 })}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline" className="rounded-panel">
              <Link href={`/?feed=${encodeURIComponent(feed.id)}`} data-testid="archived-open">
                <ExternalLink className="size-3.5" aria-hidden />
                {t("openArticles")}
              </Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-panel"
              onClick={() => void restore(feed)}
              disabled={busy !== null}
              data-testid="archived-restore"
            >
              {busy === feed.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ArchiveRestore className="size-3.5" aria-hidden />}
              {t("restore")}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
