import { db, getDatabaseProvider } from "./db";

// Audit finding P-11: free-text search (lib/search.ts) uses leading-wildcard
// `contains` (LIKE '%term%') matching, which can't use a normal B-tree index.
// This module idempotently provisions index-backed acceleration for whichever
// provider we're running against, at server startup (see instrumentation.ts).
//
// Postgres: pg_trgm GIN trigram indexes. These accelerate the EXISTING
// ILIKE '%term%' queries with *zero* change to query logic — pure win.
//
// SQLite: an FTS5 virtual table using the `trigram` tokenizer (SQLite >= 3.34),
// kept in sync via triggers. The trigram tokenizer (unlike the default
// unicode61/porter tokenizers) matches arbitrary substrings the same way
// LIKE '%term%' does, so it preserves the current matching semantics instead
// of switching to word/token based matching. lib/search.ts routes free-text
// terms of length >= 3 through this index; shorter terms and any failure
// fall back to the original LIKE-based query, so results can only get faster,
// never wrong or less complete.
//
// Everything here MUST be safe to run on every startup (idempotent DDL) and
// must never throw past ensureSearchIndexes() — a broken index setup should
// degrade to "search still works, just unaccelerated," not crash the server
// or block feed sync.

const ARTICLE_TEXT_COLUMNS = ["title", "content", "excerpt", "author"] as const;

export async function ensureSearchIndexes(): Promise<void> {
    try {
        if (getDatabaseProvider() === "postgresql") {
            await ensurePostgresTrigramIndexes();
        } else {
            await ensureSqliteFts();
        }
    } catch (err) {
        console.warn(
            "[search-indexes] Failed to set up full-text search acceleration; search will keep working, just without the index speedup.",
            err
        );
    }
}

async function ensurePostgresTrigramIndexes() {
    // Requires the pg_trgm extension to be installable by the connecting role
    // (superuser, or a role granted CREATE on the extension). If it can't be
    // created, the whole thing is caught by ensureSearchIndexes()'s try/catch.
    await db.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    for (const column of ARTICLE_TEXT_COLUMNS) {
        const indexName = `Article_${column}_trgm_idx`;
        await db.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "${indexName}" ON "Article" USING GIN ("${column}" gin_trgm_ops)`
        );
    }
}

async function ensureSqliteFts() {
    // External-content FTS5 table: the actual text stays in "Article"; this
    // table only stores the trigram index plus the cuid `id` (unindexed) so
    // matches can be mapped back to Prisma rows via `id IN (...)`.
    await db.$executeRawUnsafe(`
        CREATE VIRTUAL TABLE IF NOT EXISTS article_fts USING fts5(
            id UNINDEXED,
            title,
            content,
            excerpt,
            author,
            tokenize='trigram',
            content='Article',
            content_rowid='rowid'
        )
    `);

    await db.$executeRawUnsafe(`
        CREATE TRIGGER IF NOT EXISTS article_fts_ai AFTER INSERT ON "Article" BEGIN
            INSERT INTO article_fts(rowid, id, title, content, excerpt, author)
            VALUES (new.rowid, new.id, new.title, new.content, new.excerpt, new.author);
        END
    `);

    await db.$executeRawUnsafe(`
        CREATE TRIGGER IF NOT EXISTS article_fts_ad AFTER DELETE ON "Article" BEGIN
            INSERT INTO article_fts(article_fts, rowid, id, title, content, excerpt, author)
            VALUES ('delete', old.rowid, old.id, old.title, old.content, old.excerpt, old.author);
        END
    `);

    await db.$executeRawUnsafe(`
        CREATE TRIGGER IF NOT EXISTS article_fts_au AFTER UPDATE ON "Article" BEGIN
            INSERT INTO article_fts(article_fts, rowid, id, title, content, excerpt, author)
            VALUES ('delete', old.rowid, old.id, old.title, old.content, old.excerpt, old.author);
            INSERT INTO article_fts(rowid, id, title, content, excerpt, author)
            VALUES (new.rowid, new.id, new.title, new.content, new.excerpt, new.author);
        END
    `);

    await backfillSqliteFtsIfNeeded();
}

// NOTE: for an external-content FTS5 table, a plain (non-MATCH) `SELECT` or
// `count(*)` against article_fts is proxied straight to the backing "Article"
// table by SQLite — it does NOT reflect whether the trigram shadow index has
// actually been populated. That means "backfill only if article_fts is empty"
// can't be implemented by counting article_fts rows (it will always equal
// Article's row count, empty or not). We use a tiny marker table instead to
// track whether the one-time backfill has run.
async function backfillSqliteFtsIfNeeded() {
    await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS article_fts_meta (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            backfilled_at DATETIME
        )
    `);

    const marker = await db.$queryRawUnsafe<{ id: number }[]>(
        `SELECT id FROM article_fts_meta WHERE id = 1`
    );
    if (marker.length > 0) return;

    await db.$executeRawUnsafe(`
        INSERT INTO article_fts(rowid, id, title, content, excerpt, author)
        SELECT rowid, id, title, content, excerpt, author FROM "Article"
    `);
    await db.$executeRawUnsafe(
        `INSERT INTO article_fts_meta (id, backfilled_at) VALUES (1, CURRENT_TIMESTAMP)`
    );
}
