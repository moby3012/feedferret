-- Add browser push notification settings and subscriptions.
ALTER TABLE "User" ADD COLUMN "pushEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "pushFrequency" TEXT NOT NULL DEFAULT 'immediate';
ALTER TABLE "User" ADD COLUMN "pushFeedIds" TEXT;
ALTER TABLE "User" ADD COLUMN "pushPrivatePayloads" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "pushLastSentAt" DATETIME;

CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "platform" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME,
    "disabledAt" DATETIME,
    CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_userId_disabledAt_idx" ON "PushSubscription"("userId", "disabledAt");

-- Add FreshRSS extended OPML category/feed metadata.
ALTER TABLE "Category" ADD COLUMN "opmlUrl" TEXT;

ALTER TABLE "Feed" ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'rss';
ALTER TABLE "Feed" ADD COLUMN "htmlUrl" TEXT;
ALTER TABLE "Feed" ADD COLUMN "description" TEXT;
ALTER TABLE "Feed" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'main';
ALTER TABLE "Feed" ADD COLUMN "unicityCriteria" TEXT NOT NULL DEFAULT 'id';
ALTER TABLE "Feed" ADD COLUMN "unicityCriteriaForced" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Feed" ADD COLUMN "scraperConfig" TEXT;
ALTER TABLE "Feed" ADD COLUMN "httpOptions" TEXT;
ALTER TABLE "Feed" ADD COLUMN "fullTextConditions" TEXT;
ALTER TABLE "Feed" ADD COLUMN "filtersActionRead" TEXT;

-- Move article uniqueness toward feed-local FreshRSS unicity criteria.
ALTER TABLE "Article" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Article" ADD COLUMN "dedupeKey" TEXT;
DROP INDEX IF EXISTS "Article_userId_link_key";
CREATE UNIQUE INDEX "Article_userId_feedId_dedupeKey_key" ON "Article"("userId", "feedId", "dedupeKey");
