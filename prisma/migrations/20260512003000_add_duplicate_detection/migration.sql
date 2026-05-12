-- Add duplicate detection fields to Article
ALTER TABLE "Article" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "Article" ADD COLUMN "isDuplicate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Article" ADD COLUMN "duplicateOf" TEXT;

-- Add hide duplicates preference to User
ALTER TABLE "User" ADD COLUMN "hideDuplicates" BOOLEAN NOT NULL DEFAULT true;

-- Index for efficient cross-feed duplicate lookup
CREATE INDEX "Article_userId_contentHash_idx" ON "Article"("userId", "contentHash");

-- Backfill contentHash for existing articles using a simple URL normalization
-- (proper SHA-256 is computed in TypeScript; this approximation prevents false positives)
UPDATE "Article"
SET "contentHash" = LOWER(
  REPLACE(
    REPLACE(
      REPLACE(COALESCE(NULLIF("link", ''), "id"), 'http://', 'https://'),
      'https://www.', 'https://'
    ),
    'https://', 'https://'
  )
)
WHERE "contentHash" IS NULL;
