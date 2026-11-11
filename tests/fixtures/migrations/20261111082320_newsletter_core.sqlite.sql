-- AlterTable
ALTER TABLE "Feed" ADD COLUMN "newsletterSender" TEXT;

-- AlterTable
ALTER TABLE "Article" ADD COLUMN "confirmationUrl" TEXT;
ALTER TABLE "Article" ADD COLUMN "emailMessageId" TEXT;
ALTER TABLE "Article" ADD COLUMN "emailSender" TEXT;
ALTER TABLE "Article" ADD COLUMN "listUnsubscribeMailto" TEXT;
ALTER TABLE "Article" ADD COLUMN "listUnsubscribeOneClick" BOOLEAN;
ALTER TABLE "Article" ADD COLUMN "listUnsubscribeUrl" TEXT;
ALTER TABLE "Article" ADD COLUMN "newsletterAuth" TEXT;
ALTER TABLE "Article" ADD COLUMN "newsletterAuthDetail" TEXT;

-- CreateTable
CREATE TABLE "InboundMailSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "address" TEXT,
    "settings" TEXT,
    "credentials" TEXT,
    "webhookSecret" TEXT,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "lastReceivedAt" DATETIME,
    "lastCheckedAt" DATETIME,
    "lastError" TEXT,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NewsletterAddress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "alias" TEXT,
    "feedId" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastReceivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NewsletterAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NewsletterAddress_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NewsletterQuota" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("userId", "day"),
    CONSTRAINT "NewsletterQuota_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "InboundMailSource_kind_idx" ON "InboundMailSource"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "NewsletterAddress_token_key" ON "NewsletterAddress"("token");

-- CreateIndex
CREATE INDEX "NewsletterAddress_userId_isActive_idx" ON "NewsletterAddress"("userId", "isActive");

-- CreateIndex
CREATE INDEX "NewsletterAddress_feedId_idx" ON "NewsletterAddress"("feedId");

