import { parseCountDisplay } from "@/lib/count-display";
import { cache } from "react";
import { DEFAULT_INACTIVE_FEED_DAYS, normalizeInactiveDays } from "@/lib/broken-feeds";
import { db } from "@/lib/db";
import type { Counts } from "@/features/bootstrap/types";
import { FEED_CLIENT_SELECT } from "@/lib/feed-secrets";
import { redactFeedsForClient } from "@/lib/connector-secrets";

// Per-user entity reads of the reader shell. The read server actions
// (app/actions/feeds.ts, app/actions/settings.ts) and the server-side cold-start
// bootstrap (components/shell/bootstrap-hydrator.tsx) share them, so a hydrated
// cache entry has exactly the shape a client refetch returns.

export async function loadFeeds(userId: string) {
  // Unread counts via a single userId-scoped groupBy (served by the
  // (userId, isRead, isSpoiler, feedId) index) instead of a per-feed
  // relation _count subquery that scans Article across all users.
  const [feeds, unreadCounts] = await Promise.all([
    // Explicit allowlist (N4): this payload is embedded in every page's SSR
    // HTML, so credentials, fetch options and connector secrets stay out.
    // Archived feeds are not part of the reader shell (sidebar, counts, "Defekte Feeds");
    // Manage Feeds → "Archiviert" loads them separately via loadArchivedFeeds.
    db.feed.findMany({
      where: { userId, archivedAt: null },
      select: { ...FEED_CLIENT_SELECT, category: true },
      orderBy: [{ order: "asc" }, { name: "asc" }],
    }),
    db.article.groupBy({
      by: ["feedId"],
      where: { userId, isRead: false, isSpoiler: false },
      _count: { _all: true },
    }),
  ]);
  const unreadByFeed = new Map<string, number>(
    unreadCounts.map((item: { feedId: string; _count: { _all: number } }) => [item.feedId, item._count._all]),
  );
  return redactFeedsForClient(
    feeds.map((feed) => ({
      ...feed,
      _count: { articles: unreadByFeed.get(feed.id) ?? 0 },
    })),
  );
}

/** Archived feeds with their article / unread counts (Manage Feeds → "Archiviert"). Same client-safe shape as loadFeeds. */
export async function loadArchivedFeeds(userId: string) {
  const [feeds, articleCounts, unreadCounts] = await Promise.all([
    db.feed.findMany({
      where: { userId, archivedAt: { not: null } },
      select: { ...FEED_CLIENT_SELECT, category: true },
      orderBy: [{ archivedAt: "desc" }, { name: "asc" }],
    }),
    db.article.groupBy({ by: ["feedId"], where: { userId, feed: { archivedAt: { not: null } } }, _count: { _all: true } }),
    db.article.groupBy({ by: ["feedId"], where: { userId, isRead: false, isSpoiler: false, feed: { archivedAt: { not: null } } }, _count: { _all: true } }),
  ]);
  const total = new Map<string, number>(articleCounts.map((r: { feedId: string; _count: { _all: number } }) => [r.feedId, r._count._all]));
  const unread = new Map<string, number>(unreadCounts.map((r: { feedId: string; _count: { _all: number } }) => [r.feedId, r._count._all]));
  return redactFeedsForClient(
    feeds.map((feed) => ({ ...feed, articleCount: total.get(feed.id) ?? 0, unreadCount: unread.get(feed.id) ?? 0 })),
  );
}

export async function loadCategories(userId: string) {
  return db.category.findMany({
    where: { userId },
    include: { children: { orderBy: { order: "asc" } } },
    orderBy: { order: "asc" },
  });
}

export async function loadLabels(userId: string) {
  return db.label.findMany({
    where: { userId },
    include: {
      _count: {
        select: {
          articles: { where: { article: { isRead: false } } },
        },
      },
    },
    orderBy: { name: "asc" },
  });
}

export async function loadSavedSearches(userId: string) {
  return db.savedSearch.findMany({
    where: { userId },
    orderBy: [{ order: "asc" }, { name: "asc" }],
  });
}

/** The sidebar's notification list (newest first). */
export async function loadNotifications(userId: string, limit = 20) {
  return db.notification.findMany({
    where: { userId },
    include: {
      article: {
        select: {
          id: true,
          title: true,
          link: true,
          feed: { select: { name: true, icon: true } },
        },
      },
      alert: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
  });
}

export async function loadReadingPreferences(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      openOriginalByDefault: true,
      markReadAfterDelaySecs: true,
      defaultViewMode: true,
      readerWidth: true,
      readerFontSize: true,
      defaultArticleSort: true,
      accentColor: true,
      secondaryColor: true,
      hideDuplicates: true,
      mediaProxyImages: true,
      markReadOnScroll: true,
      markReadOnAdvance: true,
      storyClustering: true,
      clusterReadMode: true,
      layoutDirection: true,
      hideEmptyFeeds: true,
      hideEmptyLabels: true,
      countDisplay: true,
      uiLanguage: true,
      displayTimezone: true,
      autoMuteFailingFeedsAfter: true,
      inactiveFeedDays: true,
    },
  });
  return {
    openOriginalByDefault: user?.openOriginalByDefault ?? false,
    markReadAfterDelaySecs: user?.markReadAfterDelaySecs ?? null,
    defaultViewMode: user?.defaultViewMode ?? "list",
    readerWidth: user?.readerWidth ?? "normal",
    readerFontSize: user?.readerFontSize ?? "medium",
    defaultArticleSort: user?.defaultArticleSort ?? "newest",
    accentColor: user?.accentColor ?? "#5BA4CF",
    secondaryColor: user?.secondaryColor ?? "#F0963C",
    hideDuplicates: user?.hideDuplicates ?? true,
    mediaProxyImages: user?.mediaProxyImages ?? false,
    markReadOnScroll: user?.markReadOnScroll ?? false,
    markReadOnAdvance: user?.markReadOnAdvance ?? false,
    storyClustering: user?.storyClustering ?? true,
    clusterReadMode: (user?.clusterReadMode === "article" ? "article" : "story") as "story" | "article",
    layoutDirection: (user?.layoutDirection === "rtl" ? "rtl" : "ltr") as "ltr" | "rtl",
    hideEmptyFeeds: user?.hideEmptyFeeds ?? false,
    hideEmptyLabels: user?.hideEmptyLabels ?? false,
    countDisplay: parseCountDisplay(user?.countDisplay),
    uiLanguage: user?.uiLanguage ?? "en",
    displayTimezone: user?.displayTimezone ?? null,
    autoMuteFailingFeedsAfter: user?.autoMuteFailingFeedsAfter ?? 10,
    inactiveFeedDays: normalizeInactiveDays(user?.inactiveFeedDays ?? DEFAULT_INACTIVE_FEED_DAYS),
  };
}

export type ReadingPreferences = Awaited<ReturnType<typeof loadReadingPreferences>>;

/**
 * Request-scoped (React `cache`): the root layout (theme / accent / text
 * direction) and the reader page's bootstrap share one query per request.
 */
export const readingPreferencesFor = cache((userId: string) => loadReadingPreferences(userId));

/**
 * All sidebar / header / badge counts of one user in one round of parallel,
 * userId-scoped aggregate queries (served by the `(userId, isRead, isSpoiler, …)`
 * indexes). Same visibility rules as the list scopes (server/articles/view-scope.ts):
 * spoilers never count as unread, hidden duplicates are skipped when the user
 * hides duplicates, and "All articles" skips feeds / categories hidden from it.
 */
export async function getCounts(userId: string): Promise<Counts> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { hideDuplicates: true } });
  const visible: any = { userId, isSpoiler: false };
  if (user?.hideDuplicates ?? true) visible.NOT = { isDuplicate: true, duplicateOf: { not: null } };

  const [feeds, unreadByFeed, unreadByLabel, later, starred, spoiler, notifications] = await Promise.all([
    db.feed.findMany({ where: { userId }, select: { id: true, archivedAt: true, hideFromAllFeeds: true, category: { select: { hideFromAllFeeds: true } } } }),
    db.article.groupBy({ by: ["feedId"], where: { ...visible, isRead: false }, _count: { _all: true } }),
    db.articleLabel.groupBy({ by: ["labelId"], where: { userId, article: { ...visible, isRead: false } }, _count: { _all: true } }),
    db.article.count({ where: { ...visible, isReadLater: true } }),
    db.article.count({ where: { ...visible, isStarred: true } }),
    db.article.count({ where: { ...visible, isSpoiler: true } }),
    db.notification.count({ where: { userId, isRead: false } }),
  ]);

  const byFeed: Record<string, number> = {};
  for (const row of unreadByFeed) byFeed[row.feedId] = row._count._all;
  const byLabel: Record<string, number> = {};
  for (const row of unreadByLabel) byLabel[row.labelId] = row._count._all;

  let unreadTotal = 0;
  for (const feed of feeds) {
    // Archived feeds keep their articles but never count towards the unread total.
    if (feed.archivedAt || feed.hideFromAllFeeds || feed.category?.hideFromAllFeeds) continue;
    unreadTotal += byFeed[feed.id] ?? 0;
  }
  return { unreadTotal, byFeed, byLabel, later, starred, spoiler, notifications };
}

/** Everything the reader shell reads at boot except the article list itself. */
export async function getBootstrap(userId: string) {
  const [feeds, categories, labels, savedSearches, prefs, counts, notifications] = await Promise.all([
    loadFeeds(userId),
    loadCategories(userId),
    loadLabels(userId),
    loadSavedSearches(userId),
    readingPreferencesFor(userId),
    getCounts(userId),
    loadNotifications(userId),
  ]);
  return { feeds, categories, labels, savedSearches, prefs, counts, notifications };
}

export type AppBootstrap = Awaited<ReturnType<typeof getBootstrap>>;
