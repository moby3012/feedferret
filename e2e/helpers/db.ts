import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type SeedUser = {
  email: string;
  userId: string;
  firstArticleId: string;
  firstArticleTitle: string;
  firstArticleBodyStart: string;
  firstArticleFeed: string;
  sample: { code: string; image: string; long: string; needle: string; needleHits: number };
  counts: { total: number; unread: number; starred: number; readLater: number };
};
export type Manifest = { password: string; dbPath: string; users: Record<string, SeedUser> };

let cached: Manifest | undefined;
/** Read lazily: the seed (run by the Playwright webServer) writes it. */
export function manifest(): Manifest {
  cached ??= JSON.parse(fs.readFileSync(path.resolve(".e2e", "manifest.json"), "utf8")) as Manifest;
  return cached;
}

function open() {
  const db = new Database(manifest().dbPath);
  db.pragma("busy_timeout = 5000");
  return db;
}

/** Restore the seeded read / star / read-later flags for one user. */
export function resetArticleState(userKey: string) {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    db.prepare(
      `UPDATE "Article" SET
         isRead = (SELECT isRead FROM e2e_pristine WHERE articleId = "Article".id),
         readAt = (SELECT readAt FROM e2e_pristine WHERE articleId = "Article".id),
         isStarred = (SELECT isStarred FROM e2e_pristine WHERE articleId = "Article".id),
         isReadLater = (SELECT isReadLater FROM e2e_pristine WHERE articleId = "Article".id),
         readLaterSavedAt = (SELECT readLaterSavedAt FROM e2e_pristine WHERE articleId = "Article".id)
       WHERE userId = ?`,
    ).run(userId);
  } finally {
    db.close();
  }
}

export type ArticleFlags = { isRead: boolean; isStarred: boolean; isReadLater: boolean };

/** Persisted flags of one article (what the server actually stored). */
export function articleFlags(articleId: string): ArticleFlags {
  const db = open();
  try {
    const row = db
      .prepare(`SELECT isRead, isStarred, isReadLater FROM "Article" WHERE id = ?`)
      .get(articleId) as { isRead: number; isStarred: number; isReadLater: number };
    return { isRead: !!row.isRead, isStarred: !!row.isStarred, isReadLater: !!row.isReadLater };
  } finally {
    db.close();
  }
}

export function unreadCountInDb(userKey: string): number {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM "Article" WHERE userId = ? AND isRead = 0`).get(userId) as { n: number }).n;
  } finally {
    db.close();
  }
}
