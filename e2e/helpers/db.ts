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
    // Settings the specs flip must not leak between tests either.
    db.prepare(`UPDATE "User" SET markReadOnAdvance = 0, defaultViewMode = 'list' WHERE id = ?`).run(userId);
    db.prepare(`UPDATE "Article" SET isSpoiler = 0, spoilerAt = NULL WHERE userId = ? AND isSpoiler = 1`).run(userId);
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

/** Starred articles of a user (what the server persisted). */
export function starredCountInDb(userKey: string): number {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM "Article" WHERE userId = ? AND isStarred = 1`).get(userId) as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Ids of all unread articles of a user (to assert undo restores *exactly* the changed set). */
export function unreadIds(userKey: string): string[] {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    return (db.prepare(`SELECT id FROM "Article" WHERE userId = ? AND isRead = 0 ORDER BY id`).all(userId) as { id: string }[]).map((r) => r.id);
  } finally {
    db.close();
  }
}

/** Unread articles of one feed (by feed name). */
export function unreadCountForFeed(userKey: string, feedName: string): number {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM "Article" a JOIN "Feed" f ON f.id = a.feedId WHERE a.userId = ? AND a.isRead = 0 AND f.name = ?`,
        )
        .get(userId, feedName) as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

/** Make every article unread (so the unread count exceeds the 200-row list cap). */
export function markEverythingUnread(userKey: string) {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    db.prepare(`UPDATE "Article" SET isRead = 0, readAt = NULL WHERE userId = ?`).run(userId);
  } finally {
    db.close();
  }
}

export function setUserSettings(userKey: string, values: { markReadOnAdvance?: boolean; defaultViewMode?: string }) {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    if (values.markReadOnAdvance !== undefined)
      db.prepare(`UPDATE "User" SET markReadOnAdvance = ? WHERE id = ?`).run(values.markReadOnAdvance ? 1 : 0, userId);
    if (values.defaultViewMode !== undefined)
      db.prepare(`UPDATE "User" SET defaultViewMode = ? WHERE id = ?`).run(values.defaultViewMode, userId);
  } finally {
    db.close();
  }
}

/** Per-user accent colour (Settings → Appearance); drives --brand via ThemeColorApplier. */
export function setAccentColor(userKey: string, hex: string) {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    db.prepare(`UPDATE "User" SET accentColor = ? WHERE id = ?`).run(hex, userId);
  } finally {
    db.close();
  }
}

export function userSettings(userKey: string): { markReadOnAdvance: boolean } {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    const row = db.prepare(`SELECT markReadOnAdvance FROM "User" WHERE id = ?`).get(userId) as { markReadOnAdvance: number };
    return { markReadOnAdvance: !!row.markReadOnAdvance };
  } finally {
    db.close();
  }
}

/** Unread articles of a user whose title contains `text` (search-scope assertions). */
export function unreadIdsMatching(userKey: string, text: string): string[] {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    return (
      db.prepare(`SELECT id FROM "Article" WHERE userId = ? AND isRead = 0 AND title LIKE ? ORDER BY id`).all(userId, `%${text}%`) as { id: string }[]
    ).map((r) => r.id);
  } finally {
    db.close();
  }
}

/** Turn the last `count` unread articles into spoilers (so the "Spoiler" view exists). Reset by resetArticleState. */
export function makeSpoilers(userKey: string, count: number) {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    db.prepare(
      `UPDATE "Article" SET isSpoiler = 1, spoilerAt = CURRENT_TIMESTAMP WHERE id IN
         (SELECT id FROM "Article" WHERE userId = ? AND isRead = 0 ORDER BY id DESC LIMIT ?)`,
    ).run(userId, count);
  } finally {
    db.close();
  }
}
