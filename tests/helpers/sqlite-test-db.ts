// Shared bootstrap for SQLite test databases created with `prisma db push`.
//
// `db push` creates tables only. Production gets the ArticleSearch sync triggers from the
// migration (or, for db-push installs, from the startup self-check in
// lib/article-search-storage.ts), and search uses the projection only once that check has
// verified it. This helper reproduces that production state for a fresh test database:
// schema + projection triggers + "verified" (an empty database with triggers is complete).
// Tests that skip it still get correct search results: search then runs on the Article columns.
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { markArticleSearchVerifiedForTests, SQLITE_SEARCH_TRIGGERS } from "../../lib/article-search-storage";

export function pushSqliteTestDatabase(url: string, schema = "prisma/schema.generated.prisma") {
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schema], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  installSqliteSearchProjection(url);
}

export function installSqliteSearchProjection(url: string) {
  const file = url.replace(/^file:/, "");
  const sqlite = new Database(file);
  try {
    for (const statement of SQLITE_SEARCH_TRIGGERS) sqlite.exec(statement);
    const { articles, search } = sqlite.prepare('SELECT (SELECT count(*) FROM "Article") AS articles, (SELECT count(*) FROM "ArticleSearch") AS search').get() as { articles: number; search: number };
    if (articles !== search) throw new Error("installSqliteSearchProjection: call it on a fresh database, before inserting articles");
  } finally {
    sqlite.close();
  }
  markArticleSearchVerifiedForTests();
}
