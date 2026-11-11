-- Article: spoiler flag (only set by rules; filtered out of all views except the Spoiler feed)
ALTER TABLE "Article" ADD COLUMN "isSpoiler" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Article" ADD COLUMN "spoilerAt" DATETIME;

CREATE INDEX "Article_userId_isSpoiler_publishedAt_idx" ON "Article"("userId", "isSpoiler", "publishedAt");
