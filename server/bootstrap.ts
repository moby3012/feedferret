import { db } from "@/lib/db";
import type { Counts } from "@/features/bootstrap/types";

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
    db.feed.findMany({ where: { userId }, select: { id: true, hideFromAllFeeds: true, category: { select: { hideFromAllFeeds: true } } } }),
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
    if (feed.hideFromAllFeeds || feed.category?.hideFromAllFeeds) continue;
    unreadTotal += byFeed[feed.id] ?? 0;
  }
  return { unreadTotal, byFeed, byLabel, later, starred, spoiler, notifications };
}
