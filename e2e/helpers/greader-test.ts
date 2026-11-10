import Database from "better-sqlite3";
import { test as base, expect } from "@playwright/test";
import { manifest } from "./db";

// These specs share the app projects' seeded users. Restore even on assertion
// failure, without relying on HTTP cleanup that can fail auth or rate limits.
export const test = base.extend<{ restoreGReaderState: void }>({
  restoreGReaderState: [async ({}, runTest, testInfo) => {
    const userKey = testInfo.project.name === "mobile" ? "mobile" : "desktop";
    const { userId } = manifest().users[userKey];
    const db = new Database(manifest().dbPath);
    db.pragma("busy_timeout = 5000");
    const userColumns = [
      "apiPasswordHash", "apiPasswordCreatedAt", "apiPasswordLastUsedAt",
      "apiPasswordRequired", "apiTokenVersion", "apiFeverKey", "updatedAt",
    ];
    try {
      const user = db.prepare(`SELECT ${userColumns.join(", ")} FROM "User" WHERE id = ?`).get(userId) as Record<string, string | number | null>;
      const feeds = db.prepare('SELECT id, name, updatedAt FROM "Feed" WHERE userId = ?').all(userId) as { id: string; name: string; updatedAt: string | number }[];
      try {
        await runTest();
      } finally {
        db.prepare("BEGIN IMMEDIATE").run();
        try {
          const restoreFeed = db.prepare('UPDATE "Feed" SET name = ?, updatedAt = ? WHERE id = ? AND userId = ?');
          for (const feed of feeds) restoreFeed.run(feed.name, feed.updatedAt, feed.id, userId);
          db.prepare(`UPDATE "User" SET ${userColumns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
            .run(...userColumns.map((column) => user[column]), userId);
          db.prepare("COMMIT").run();
        } catch (error) {
          db.prepare("ROLLBACK").run();
          throw error;
        }
        expect(db.prepare(`SELECT ${userColumns.join(", ")} FROM "User" WHERE id = ?`).get(userId)).toEqual(user);
        expect(db.prepare('SELECT id, name, updatedAt FROM "Feed" WHERE userId = ?').all(userId)).toEqual(feeds);
      }
    } finally {
      db.close();
    }
  }, { auto: true }],
});

export { expect };
