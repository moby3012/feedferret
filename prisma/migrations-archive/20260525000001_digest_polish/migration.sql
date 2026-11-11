ALTER TABLE "User" ADD COLUMN "digestSkipFeatured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "digestLabelIds" TEXT;
ALTER TABLE "User" ADD COLUMN "digestPausedUntil" DATETIME;
ALTER TABLE "Article" ADD COLUMN "digestedAt" DATETIME;
CREATE INDEX "Article_userId_digestedAt_idx" ON "Article"("userId", "digestedAt");
