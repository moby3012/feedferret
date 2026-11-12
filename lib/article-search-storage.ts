import { db, getDatabaseProvider } from "./db";

// Kept identical to the additive migration (tested). migrate deploy installs these;
// explicit db-push/dev databases need the same triggers before ingestion starts.
export const SQLITE_SEARCH_TRIGGERS = [
    `CREATE TRIGGER IF NOT EXISTS article_search_ai AFTER INSERT ON "Article"
BEGIN
    INSERT INTO "ArticleSearch" (rowid, "id", "title", "content", "excerpt", "author", "entities") VALUES (NEW.rowid, NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities");
END`,
    `CREATE TRIGGER IF NOT EXISTS article_search_au AFTER UPDATE OF "id", "title", "content", "excerpt", "author", "entities" ON "Article"
WHEN OLD."id" IS NOT NEW."id" OR OLD."title" IS NOT NEW."title" OR OLD."content" IS NOT NEW."content" OR OLD."excerpt" IS NOT NEW."excerpt" OR OLD."author" IS NOT NEW."author" OR OLD."entities" IS NOT NEW."entities"
BEGIN
    INSERT INTO "ArticleSearch" (rowid, "id", "title", "content", "excerpt", "author", "entities") VALUES (NEW.rowid, NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities") ON CONFLICT(id)
    DO UPDATE SET "title" = excluded."title", "content" = excluded."content", "excerpt" = excluded."excerpt", "author" = excluded."author", "entities" = excluded."entities";
END`,
];

export const POSTGRES_SEARCH_TRIGGERS = [
    `CREATE OR REPLACE FUNCTION article_search_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO "ArticleSearch" ("id", "title", "content", "excerpt", "author", "entities") VALUES (NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities") ON CONFLICT ("id")
    DO UPDATE SET "title" = excluded."title", "content" = excluded."content", "excerpt" = excluded."excerpt", "author" = excluded."author", "entities" = excluded."entities";
    RETURN NEW;
END $$`,
    `CREATE TRIGGER article_search_ai AFTER INSERT ON "Article" FOR EACH ROW EXECUTE FUNCTION article_search_sync()`,
    `CREATE TRIGGER article_search_au AFTER UPDATE OF "id", "title", "content", "excerpt", "author", "entities" ON "Article"
FOR EACH ROW WHEN (ROW(OLD."id", OLD."title", OLD."content", OLD."excerpt", OLD."author", OLD."entities") IS DISTINCT FROM ROW(NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities")) EXECUTE FUNCTION article_search_sync()`,
];

export async function ensureArticleSearchStorage() {
    const pg = getDatabaseProvider() === "postgresql";
    const installed = await db.$queryRawUnsafe<unknown[]>(pg
        ? "SELECT 1 FROM pg_trigger WHERE tgname = 'article_search_ai' AND tgrelid = '\"Article\"'::regclass"
        : "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'article_search_ai'");
    if (installed.length) return;
    await db.$transaction([
        ...(pg ? POSTGRES_SEARCH_TRIGGERS : SQLITE_SEARCH_TRIGGERS).map(sql => db.$executeRawUnsafe(sql)),
        db.$executeRawUnsafe(pg
            ? 'INSERT INTO "ArticleSearch" ("id", "title", "content", "excerpt", "author", "entities") SELECT "id", "title", "content", "excerpt", "author", "entities" FROM "Article" ON CONFLICT ("id") DO NOTHING'
            : 'INSERT INTO "ArticleSearch" (rowid, "id", "title", "content", "excerpt", "author", "entities") SELECT rowid, "id", "title", "content", "excerpt", "author", "entities" FROM "Article" WHERE true ON CONFLICT ("id") DO NOTHING'),
    ]);
}
