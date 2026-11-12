// Subscribing to a URL the user already has as an ARCHIVED feed must not fail with a unique-constraint
// error (or hand back a stream that is invisible to the client): the archived subscription is restored
// instead, and the caller tells the user so. `Feed.url` is unique per user, so the match is exact.
import { db } from "@/lib/db";

/** Restores the user's archived feed stored under `url` (secret-free, as stored). Null when there is none. */
export async function restoreArchivedFeedByUrl(userId: string, url: string) {
  const archived = await db.feed.findFirst({ where: { userId, url, archivedAt: { not: null } }, select: { id: true } });
  if (!archived) return null;
  // Guarded on `archivedAt` so a concurrent restore is harmless; the feed row is the only thing written.
  await db.feed.updateMany({ where: { id: archived.id, userId, archivedAt: { not: null } }, data: { archivedAt: null } });
  return db.feed.findFirst({ where: { id: archived.id, userId }, include: { category: true } });
}
