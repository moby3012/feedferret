-- CreateTable
CREATE TABLE "ArticleSearch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "excerpt" TEXT,
    "author" TEXT,
    "entities" TEXT,
    CONSTRAINT "ArticleSearch_id_fkey" FOREIGN KEY ("id") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);


CREATE TRIGGER IF NOT EXISTS article_search_ai AFTER INSERT ON "Article"
BEGIN
    INSERT INTO "ArticleSearch" (rowid, "id", "title", "content", "excerpt", "author", "entities") VALUES (NEW.rowid, NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities");
END;

CREATE TRIGGER IF NOT EXISTS article_search_au AFTER UPDATE OF "id", "title", "content", "excerpt", "author", "entities" ON "Article"
WHEN OLD."id" IS NOT NEW."id" OR OLD."title" IS NOT NEW."title" OR OLD."content" IS NOT NEW."content" OR OLD."excerpt" IS NOT NEW."excerpt" OR OLD."author" IS NOT NEW."author" OR OLD."entities" IS NOT NEW."entities"
BEGIN
    INSERT INTO "ArticleSearch" (rowid, "id", "title", "content", "excerpt", "author", "entities") VALUES (NEW.rowid, NEW."id", NEW."title", NEW."content", NEW."excerpt", NEW."author", NEW."entities") ON CONFLICT(id)
    DO UPDATE SET "title" = excluded."title", "content" = excluded."content", "excerpt" = excluded."excerpt", "author" = excluded."author", "entities" = excluded."entities";
END;

INSERT INTO "ArticleSearch" (rowid, "id", "title", "content", "excerpt", "author", "entities") SELECT rowid, "id", "title", "content", "excerpt", "author", "entities" FROM "Article" WHERE true ON CONFLICT ("id") DO NOTHING;
