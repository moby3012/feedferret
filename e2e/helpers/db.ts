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
    db.prepare(`UPDATE "User" SET markReadOnAdvance = 0, defaultViewMode = 'list', countDisplay = 'all' WHERE id = ?`).run(userId);
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

export function setUserSettings(userKey: string, values: { markReadOnAdvance?: boolean; defaultViewMode?: string; readerWidth?: string }) {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    if (values.markReadOnAdvance !== undefined)
      db.prepare(`UPDATE "User" SET markReadOnAdvance = ? WHERE id = ?`).run(values.markReadOnAdvance ? 1 : 0, userId);
    if (values.defaultViewMode !== undefined)
      db.prepare(`UPDATE "User" SET defaultViewMode = ? WHERE id = ?`).run(values.defaultViewMode, userId);
    if (values.readerWidth !== undefined) db.prepare(`UPDATE "User" SET readerWidth = ? WHERE id = ?`).run(values.readerWidth, userId);
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

const ARTICLE_EXTRA_COLUMNS = ["kind", "mediaUrl", "mediaType", "mediaDurationSecs", "imageUrl", "isSponsored", "isClickbait", "cleanTitle", "clusterId"] as const;
type ArticleExtraColumn = (typeof ARTICLE_EXTRA_COLUMNS)[number];

/**
 * Overwrites list-metadata columns (kind, media, K3 enrichment, cluster) of
 * some seeded articles and returns a function that restores the previous
 * values. Callers restore in `finally` — the seed has none of these set.
 */
export function patchArticles(articleIds: string[], values: Partial<Record<ArticleExtraColumn, string | number | null>>): () => void {
  const cols = Object.keys(values) as ArticleExtraColumn[];
  for (const c of cols) if (!ARTICLE_EXTRA_COLUMNS.includes(c)) throw new Error(`patchArticles: column ${c} not allowed`);
  const db = open();
  let before: Array<Record<string, unknown>>;
  try {
    before = articleIds.map((id) => db.prepare(`SELECT id, ${cols.map((c) => `"${c}"`).join(", ")} FROM "Article" WHERE id = ?`).get(id) as Record<string, unknown>);
    const set = db.prepare(`UPDATE "Article" SET ${cols.map((c) => `"${c}" = @${c}`).join(", ")} WHERE id = @id`);
    for (const id of articleIds) set.run({ ...values, id });
  } finally {
    db.close();
  }
  return () => {
    const restore = open();
    try {
      const set = restore.prepare(`UPDATE "Article" SET ${cols.map((c) => `"${c}" = @${c}`).join(", ")} WHERE id = @id`);
      for (const row of before) set.run(row);
    } finally {
      restore.close();
    }
  };
}

/**
 * Creates a story cluster over `articleIds` (lead first) for one user and
 * returns a cleanup that detaches the members and deletes the cluster.
 */
let clusterSeq = 0;
export function makeStoryCluster(userKey: string, articleIds: string[]): () => void {
  const { userId } = manifest().users[userKey];
  // Two clusters in the same millisecond must not share an id.
  const id = `e2e-cluster-${userKey}-${Date.now()}-${clusterSeq++}`;
  const now = new Date().toISOString();
  const db = open();
  try {
    db.prepare(
      `INSERT INTO "StoryCluster" (id, userId, leadArticleId, size, feedCount, firstSeenAt, lastSeenAt, sig, algoVersion, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?)`,
    ).run(id, userId, articleIds[0], articleIds.length, articleIds.length, now, now, now, now);
    const set = db.prepare(`UPDATE "Article" SET clusterId = ? WHERE id = ? AND userId = ?`);
    for (const articleId of articleIds) set.run(id, articleId, userId);
  } finally {
    db.close();
  }
  return () => {
    const c = open();
    try {
      c.prepare(`UPDATE "Article" SET clusterId = NULL WHERE clusterId = ?`).run(id);
      c.prepare(`DELETE FROM "StoryCluster" WHERE id = ?`).run(id);
    } finally {
      c.close();
    }
  };
}

/** User flags the list specs flip (restored by the returned function). */
export function setUserFlags(userKey: string, values: { aiCleanTitles?: boolean; clusterReadMode?: "story" | "article"; defaultViewMode?: string }): () => void {
  const { userId } = manifest().users[userKey];
  const db = open();
  let before: { aiCleanTitles: number; clusterReadMode: string; defaultViewMode: string };
  try {
    before = db.prepare(`SELECT aiCleanTitles, clusterReadMode, defaultViewMode FROM "User" WHERE id = ?`).get(userId) as typeof before;
    if (values.aiCleanTitles !== undefined) db.prepare(`UPDATE "User" SET aiCleanTitles = ? WHERE id = ?`).run(values.aiCleanTitles ? 1 : 0, userId);
    if (values.clusterReadMode !== undefined) db.prepare(`UPDATE "User" SET clusterReadMode = ? WHERE id = ?`).run(values.clusterReadMode, userId);
    if (values.defaultViewMode !== undefined) db.prepare(`UPDATE "User" SET defaultViewMode = ? WHERE id = ?`).run(values.defaultViewMode, userId);
  } finally {
    db.close();
  }
  return () => {
    const c = open();
    try {
      c.prepare(`UPDATE "User" SET aiCleanTitles = ?, clusterReadMode = ?, defaultViewMode = ? WHERE id = ?`).run(before.aiCleanTitles, before.clusterReadMode, before.defaultViewMode, userId);
    } finally {
      c.close();
    }
  };
}

/**
 * Creates a feed with `count` unread articles for one user ("Bulk n" titles,
 * newest first = n 0) and returns its id, the article ids in list order and a
 * cleanup that deletes both. Callers clean up in `finally` (resetArticleState
 * only knows the seeded rows).
 */
export function insertBulkFeed(userKey: string, count: number): { feedId: string; ids: string[]; cleanup: () => void } {
  const { userId } = manifest().users[userKey];
  const feedId = `e2e-bulk-feed-${userKey}-${Date.now()}`;
  const ids = Array.from({ length: count }, (_, i) => `e2e-bulk-${userKey}-${String(i).padStart(5, "0")}`);
  const db = open();
  try {
    const now = new Date();
    // Prisma's SQLite text format ("…+00:00", not "…Z"): DateTime filters compare as text.
    const iso = (d: Date) => d.toISOString().replace("Z", "+00:00");
    const created = iso(new Date(now.getTime() - 60_000));
    db.prepare(`INSERT INTO "Feed" (id, url, name, userId, updatedAt) VALUES (?, ?, ?, ?, ?)`).run(feedId, `https://bulk.e2e.test/${feedId}`, "Bulk feed", userId, iso(now));
    const insert = db.prepare(
      `INSERT INTO "Article" (id, feedId, userId, title, link, content, excerpt, publishedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?)`,
    );
    db.prepare("BEGIN").run();
    ids.forEach((id, i) => insert.run(id, feedId, userId, `Bulk ${i}`, `https://bulk.e2e.test/${id}`, iso(new Date(now.getTime() - (i + 1) * 60_000)), created, created));
    db.prepare("COMMIT").run();
  } finally {
    db.close();
  }
  return {
    feedId,
    ids,
    cleanup: () => {
      const c = open();
      try {
        c.prepare(`DELETE FROM "Article" WHERE feedId = ?`).run(feedId);
        c.prepare(`DELETE FROM "Feed" WHERE id = ?`).run(feedId);
      } finally {
        c.close();
      }
    },
  };
}

/** Read flags of many articles at once (id → isRead). */
export function readFlags(articleIds: string[]): Map<string, boolean> {
  const db = open();
  try {
    const out = new Map<string, boolean>();
    for (let i = 0; i < articleIds.length; i += 500) {
      const chunk = articleIds.slice(i, i + 500);
      const rows = db.prepare(`SELECT id, isRead FROM "Article" WHERE id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as { id: string; isRead: number }[];
      for (const r of rows) out.set(r.id, !!r.isRead);
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * A NEW unread article (createdAt = now) placed in list order right below
 * `belowId` (publishedAt 30 s older, same feed): a backdated arrival that
 * lands inside an already loaded span. Removed by the returned function.
 */
export function insertArrivalBelow(belowId: string, id: string): () => void {
  const db = open();
  try {
    const iso = (d: Date) => d.toISOString().replace("Z", "+00:00");
    const ref = db.prepare(`SELECT feedId, userId, publishedAt FROM "Article" WHERE id = ?`).get(belowId) as { feedId: string; userId: string; publishedAt: string };
    const publishedAt = new Date(new Date(ref.publishedAt).getTime() - 30_000);
    const now = iso(new Date());
    db.prepare(
      `INSERT INTO "Article" (id, feedId, userId, title, link, content, excerpt, publishedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?)`,
    ).run(id, ref.feedId, ref.userId, `Arrival ${id}`, `https://arrival.e2e.test/${id}`, iso(publishedAt), now, now);
  } finally {
    db.close();
  }
  return () => {
    const c = open();
    try {
      c.prepare(`DELETE FROM "Article" WHERE id = ?`).run(id);
    } finally {
      c.close();
    }
  };
}

/**
 * `n` NEW unread articles (createdAt = publishedAt = now, newest last) in the
 * feed of the user's first seeded article: what a background sync would add
 * on top of the Neu list. Titles "Arrival <tag> <i>". Removed by the returned function.
 */
export function insertArrivals(userKey: string, n: number, tag = "x"): { ids: string[]; cleanup: () => void } {
  const user = manifest().users[userKey];
  const db = open();
  const ids = Array.from({ length: n }, (_, i) => `e2e-arrival-${userKey}-${tag}-${i}`);
  try {
    const iso = (d: Date) => d.toISOString().replace("Z", "+00:00");
    const ref = db.prepare(`SELECT feedId FROM "Article" WHERE id = ?`).get(user.firstArticleId) as { feedId: string };
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO "Article" (id, feedId, userId, title, link, content, excerpt, publishedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?)`,
    );
    ids.forEach((id, i) => {
      const at = iso(new Date(now + i * 1000));
      insert.run(id, ref.feedId, user.userId, `Arrival ${tag} ${i}`, `https://arrival.e2e.test/${id}`, at, at, at);
    });
  } finally {
    db.close();
  }
  return {
    ids,
    cleanup: () => {
      const c = open();
      try {
        c.prepare(`DELETE FROM "Article" WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
      } finally {
        c.close();
      }
    },
  };
}

/** `User.countDisplay` ("all" | "categories" | "off"); resetArticleState restores "all". */
export function setCountDisplay(userKey: string, mode: "all" | "categories" | "off") {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    db.prepare(`UPDATE "User" SET countDisplay = ? WHERE id = ?`).run(mode, userId);
  } finally {
    db.close();
  }
}

/**
 * A brand-new account without feeds: a copy of the seeded user's row (same
 * password) under a new id / e-mail. Log in through the form; the cleanup
 * deletes it (sessions etc. cascade).
 */
export function createEmptyUser(userKey: string, tag: string): { email: string; cleanup: () => void } {
  const { userId } = manifest().users[userKey];
  const db = open();
  const id = `e2e-empty-${tag}-${Date.now().toString(36)}`;
  const email = `${id}@e2e.test`;
  try {
    const row = db.prepare(`SELECT * FROM "User" WHERE id = ?`).get(userId) as Record<string, unknown>;
    const copy: Record<string, unknown> = { ...row, id, email, name: "Empty" };
    // Unique per-user secrets / tokens must not be duplicated.
    for (const key of ["apiFeverKey", "digestUnsubscribeToken"]) if (key in copy) copy[key] = null;
    const cols = Object.keys(copy);
    db.prepare(`INSERT INTO "User" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
      ...cols.map((c) => copy[c] as string | number | null),
    );
  } finally {
    db.close();
  }
  return {
    email,
    cleanup: () => {
      const c = open();
      try {
        c.pragma("foreign_keys = ON");
        c.prepare(`DELETE FROM "User" WHERE id = ?`).run(id);
      } finally {
        c.close();
      }
    },
  };
}

/** Nothing saved for later / starred for one user (resetArticleState restores the seed). */
export function clearSaved(userKey: string) {
  const { userId } = manifest().users[userKey];
  const db = open();
  try {
    db.prepare(`UPDATE "Article" SET isReadLater = 0, readLaterSavedAt = NULL, isStarred = 0 WHERE userId = ?`).run(userId);
  } finally {
    db.close();
  }
}

/**
 * Stores fetch credentials / options on one seeded feed of the user (security
 * wave 3, N4) and returns the planted secret strings plus a restore callback.
 * No proxy / auth type is set, so background syncs of the fixture feed keep
 * working while the secrets sit in the row.
 */
export function plantFeedSecrets(userKey: string): { secrets: string[]; restore: () => void } {
  const { userId } = manifest().users[userKey];
  const tag = `${userKey}-${Date.now()}`;
  const secrets = [`E2E-SECRET-PASS-${tag}`, `e2e-secret-user-${tag}`, `E2E-SECRET-COOKIE-${tag}`, `E2E-SECRET-SCRAPER-${tag}`];
  const db = open();
  let feed: { id: string; authUsername: string | null; authPassword: string | null; httpOptions: string | null; scraperConfig: string | null };
  try {
    feed = db.prepare(`SELECT id, authUsername, authPassword, httpOptions, scraperConfig FROM "Feed" WHERE userId = ? ORDER BY "order" LIMIT 1`).get(userId) as typeof feed;
    db.prepare(`UPDATE "Feed" SET authPassword = ?, authUsername = ?, httpOptions = ?, scraperConfig = ? WHERE id = ?`).run(
      secrets[0],
      secrets[1],
      JSON.stringify({ CURLOPT_COOKIE: secrets[2] }),
      JSON.stringify({ marker: secrets[3] }),
      feed.id,
    );
  } finally {
    db.close();
  }
  return {
    secrets,
    restore: () => {
      const c = open();
      try {
        c.prepare(`UPDATE "Feed" SET authPassword = ?, authUsername = ?, httpOptions = ?, scraperConfig = ? WHERE id = ?`).run(
          feed.authPassword, feed.authUsername, feed.httpOptions, feed.scraperConfig, feed.id,
        );
      } finally {
        c.close();
      }
    },
  };
}
