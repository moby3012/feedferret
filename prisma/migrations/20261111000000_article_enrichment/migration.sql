-- K3: piggyback enrichment (entities, sponsored/clickbait flags, neutral title). Additive and nullable.
ALTER TABLE "Article" ADD COLUMN "entities" TEXT;
ALTER TABLE "Article" ADD COLUMN "isSponsored" BOOLEAN;
ALTER TABLE "Article" ADD COLUMN "isClickbait" BOOLEAN;
ALTER TABLE "Article" ADD COLUMN "cleanTitle" TEXT;
ALTER TABLE "Article" ADD COLUMN "enrichSource" TEXT;
ALTER TABLE "User" ADD COLUMN "aiCleanTitles" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Article_userId_isSponsored_idx" ON "Article"("userId", "isSponsored");
