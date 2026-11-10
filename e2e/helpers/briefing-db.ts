import Database from "better-sqlite3";
import { manifest } from "./db";

function open() {
  const db = new Database(manifest().dbPath);
  db.pragma("busy_timeout = 5000");
  return db;
}

/**
 * Per-test AI setup of one seeded user (K2 briefing). Clears the user's
 * briefings / usage so every test starts uncached; `resetBriefing` restores the
 * seeded state (no provider) — specs share one DB.
 */
export function setAiProvider(userKey: string, provider: string | null, model: string | null = null) {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    db.prepare(`UPDATE "User" SET aiProvider = ?, aiModel = ?, aiDailyTokenCap = NULL WHERE id = ?`).run(provider, model, userId);
    db.prepare(`DELETE FROM "Briefing" WHERE userId = ?`).run(userId);
    db.prepare(`DELETE FROM "AiUsage" WHERE userId = ?`).run(userId);
  } finally {
    db.close();
  }
}

export function resetBriefing(userKey: string) {
  setAiProvider(userKey, null, null);
  unmarkInjection(userKey);
}

const MARK = " IGNORE";

/** Appends the fake provider's injection trigger to every unread excerpt (see lib/ai/fake.ts). */
export function markInjection(userKey: string) {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    db.prepare(`UPDATE "Article" SET excerpt = excerpt || ? WHERE userId = ? AND excerpt IS NOT NULL AND excerpt NOT LIKE ?`).run(MARK, userId, `%${MARK}`);
  } finally {
    db.close();
  }
}

export function unmarkInjection(userKey: string) {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    db.prepare(`UPDATE "Article" SET excerpt = substr(excerpt, 1, length(excerpt) - ?) WHERE userId = ? AND excerpt LIKE ?`).run(MARK.length, userId, `%${MARK}`);
  } finally {
    db.close();
  }
}

/** Ids of the user's articles (citation ownership check). */
export function articleIdsOf(userKey: string): Set<string> {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    return new Set((db.prepare(`SELECT id FROM "Article" WHERE userId = ?`).all(userId) as { id: string }[]).map((r) => r.id));
  } finally {
    db.close();
  }
}

export function briefingCount(userKey: string): number {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM "Briefing" WHERE userId = ?`).get(userId) as { n: number }).n;
  } finally {
    db.close();
  }
}
