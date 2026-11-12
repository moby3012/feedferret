-- ff:allow-destructive Replace only disposable Article GIN indexes after the new projection is indexed; retain all Article columns.
-- Short schema/trigger installation transaction.
BEGIN;
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
  RAISE NOTICE 'pg_trgm unavailable';
END $$;

-- CreateTable
CREATE TABLE "ArticleSearch" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "excerpt" TEXT,
    "author" TEXT,
    "entities" TEXT,

    CONSTRAINT "ArticleSearch_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ArticleSearch" ADD CONSTRAINT "ArticleSearch_id_fkey" FOREIGN KEY ("id") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION article_search_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO "ArticleSearch" ("id", "title", "content", "excerpt", "author", "entities") VALUES (NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities") ON CONFLICT ("id")
    DO UPDATE SET "title" = excluded."title", "content" = excluded."content", "excerpt" = excluded."excerpt", "author" = excluded."author", "entities" = excluded."entities";
    RETURN NEW;
END $$;

CREATE TRIGGER article_search_ai AFTER INSERT ON "Article" FOR EACH ROW EXECUTE FUNCTION article_search_sync();

CREATE TRIGGER article_search_au AFTER UPDATE OF "id", "title", "content", "excerpt", "author", "entities" ON "Article"
FOR EACH ROW WHEN (ROW(OLD."id", OLD."title", OLD."content", OLD."excerpt", OLD."author", OLD."entities") IS DISTINCT FROM ROW(NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities")) EXECUTE FUNCTION article_search_sync();
COMMIT;

-- Copy without holding the schema-installation locks on Article.
BEGIN;
INSERT INTO "ArticleSearch" ("id", "title", "content", "excerpt", "author", "entities") SELECT "id", "title", "content", "excerpt", "author", "entities" FROM "Article" FOR KEY SHARE ON CONFLICT ("id") DO NOTHING;
COMMIT;

-- Index the populated projection before dropping the original GIN indexes.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS "ArticleSearch_title_trgm_idx" ON "ArticleSearch" USING GIN ("title" gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "ArticleSearch_content_trgm_idx" ON "ArticleSearch" USING GIN ("content" gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "ArticleSearch_excerpt_trgm_idx" ON "ArticleSearch" USING GIN ("excerpt" gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "ArticleSearch_author_trgm_idx" ON "ArticleSearch" USING GIN ("author" gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "ArticleSearch_entities_trgm_idx" ON "ArticleSearch" USING GIN ("entities" gin_trgm_ops);
  END IF;
END $$;

DROP INDEX IF EXISTS "Article_title_trgm_idx";
DROP INDEX IF EXISTS "Article_content_trgm_idx";
DROP INDEX IF EXISTS "Article_excerpt_trgm_idx";
DROP INDEX IF EXISTS "Article_author_trgm_idx";
DROP INDEX IF EXISTS "Article_entities_trgm_idx";
