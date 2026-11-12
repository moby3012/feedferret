-- ff:allow-destructive Empty databases only (fresh install, Prisma shadow replay): swap the five disposable Article GIN indexes for ArticleSearch ones. Populated databases keep them; lib/search-indexes.ts swaps them in the background with CREATE/DROP INDEX CONCURRENTLY. No Article column or row is removed.
--
-- Every statement is idempotent so an interrupted deploy can simply be re-run
-- (`prisma migrate resolve --rolled-back 20261112093000_article_search_table`, restart).
-- Each phase is its own short transaction; no phase locks ArticleSearch and then Article.
-- On a populated database this migration builds NO index: GIN builds would hold a SHARE
-- lock on ArticleSearch (blocking ingestion through the trigger) for minutes.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
  RAISE NOTICE 'pg_trgm unavailable';
END $$;

-- Phase 1: table, FK and sync triggers (short SHARE ROW EXCLUSIVE lock on Article, first run only).
BEGIN;
CREATE TABLE IF NOT EXISTS "ArticleSearch" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "excerpt" TEXT,
    "author" TEXT,
    "entities" TEXT,

    CONSTRAINT "ArticleSearch_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ArticleSearch_id_fkey' AND conrelid = '"ArticleSearch"'::regclass) THEN
    ALTER TABLE "ArticleSearch" ADD CONSTRAINT "ArticleSearch_id_fkey" FOREIGN KEY ("id") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION article_search_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO "ArticleSearch" ("id", "title", "content", "excerpt", "author", "entities") VALUES (NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities") ON CONFLICT ("id")
    DO UPDATE SET "title" = excluded."title", "content" = excluded."content", "excerpt" = excluded."excerpt", "author" = excluded."author", "entities" = excluded."entities";
    RETURN NEW;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'article_search_ai' AND tgrelid = '"Article"'::regclass) THEN
    CREATE TRIGGER article_search_ai AFTER INSERT ON "Article" FOR EACH ROW EXECUTE FUNCTION article_search_sync();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'article_search_au' AND tgrelid = '"Article"'::regclass) THEN
    CREATE TRIGGER article_search_au AFTER UPDATE OF "id", "title", "content", "excerpt", "author", "entities" ON "Article"
    FOR EACH ROW WHEN (ROW(OLD."id", OLD."title", OLD."content", OLD."excerpt", OLD."author", OLD."entities") IS DISTINCT FROM ROW(NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities")) EXECUTE FUNCTION article_search_sync();
  END IF;
END $$;
COMMIT;

-- Phase 2: copy into the (still unindexed) projection under a SHARE lock on Article. Writers
-- wait for the copy (seconds, see docs/performance/article-search-table.md) but can never
-- deadlock with it: every transaction that already wrote Article finishes before the copy starts,
-- so no trigger-written projection row can be in flight. ON CONFLICT DO NOTHING makes a re-run
-- cheap. If the lock is not granted within lock_timeout (a long-running transaction), the copy is
-- deferred instead of failing the deploy: the app's startup self-check
-- (lib/article-search-storage.ts) finds the gap and fills it in small batches.
BEGIN;
SET LOCAL lock_timeout = '15s';
DO $$ BEGIN
  LOCK TABLE "Article" IN SHARE MODE;
  INSERT INTO "ArticleSearch" ("id", "title", "content", "excerpt", "author", "entities")
  SELECT "id", "title", "content", "excerpt", "author", "entities" FROM "Article"
  ON CONFLICT ("id") DO NOTHING;
EXCEPTION WHEN lock_not_available OR deadlock_detected OR query_canceled THEN
  RAISE WARNING 'ArticleSearch backfill deferred to application startup: %', SQLERRM;
END $$;
COMMIT;

-- Phase 3 (empty databases only): drop the old Article trigram indexes. Takes only the Article
-- lock; ArticleSearch is untouched in this transaction.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Article" LIMIT 1) THEN
    DROP INDEX IF EXISTS "Article_title_trgm_idx";
    DROP INDEX IF EXISTS "Article_content_trgm_idx";
    DROP INDEX IF EXISTS "Article_excerpt_trgm_idx";
    DROP INDEX IF EXISTS "Article_author_trgm_idx";
    DROP INDEX IF EXISTS "Article_entities_trgm_idx";
  END IF;
END $$;
COMMIT;

-- Phase 4 (empty projection only): instant GIN builds. Takes only the ArticleSearch lock.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    IF NOT EXISTS (SELECT 1 FROM "ArticleSearch" LIMIT 1) THEN
      CREATE INDEX IF NOT EXISTS "ArticleSearch_title_trgm_idx" ON "ArticleSearch" USING GIN ("title" gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS "ArticleSearch_content_trgm_idx" ON "ArticleSearch" USING GIN ("content" gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS "ArticleSearch_excerpt_trgm_idx" ON "ArticleSearch" USING GIN ("excerpt" gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS "ArticleSearch_author_trgm_idx" ON "ArticleSearch" USING GIN ("author" gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS "ArticleSearch_entities_trgm_idx" ON "ArticleSearch" USING GIN ("entities" gin_trgm_ops);
    END IF;
  END IF;
END $$;
COMMIT;
