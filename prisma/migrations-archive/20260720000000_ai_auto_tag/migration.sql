-- F8: AI auto-tagging of new articles (reuses the existing Label/ArticleLabel schema).
ALTER TABLE "User" ADD COLUMN "aiAutoTag" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Article" ADD COLUMN "aiTaggedAt" DATETIME;
