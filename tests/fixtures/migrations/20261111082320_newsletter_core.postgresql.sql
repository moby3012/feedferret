-- AlterTable
ALTER TABLE "Feed" ADD COLUMN     "newsletterSender" TEXT;

-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "confirmationUrl" TEXT,
ADD COLUMN     "emailMessageId" TEXT,
ADD COLUMN     "emailSender" TEXT,
ADD COLUMN     "listUnsubscribeMailto" TEXT,
ADD COLUMN     "listUnsubscribeOneClick" BOOLEAN,
ADD COLUMN     "listUnsubscribeUrl" TEXT,
ADD COLUMN     "newsletterAuth" TEXT,
ADD COLUMN     "newsletterAuthDetail" TEXT;

-- CreateTable
CREATE TABLE "InboundMailSource" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "address" TEXT,
    "settings" TEXT,
    "credentials" TEXT,
    "webhookSecret" TEXT,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "lastReceivedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundMailSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsletterAddress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "alias" TEXT,
    "feedId" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastReceivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsletterAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsletterQuota" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "NewsletterQuota_pkey" PRIMARY KEY ("userId","day")
);

-- CreateIndex
CREATE INDEX "InboundMailSource_kind_idx" ON "InboundMailSource"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "NewsletterAddress_token_key" ON "NewsletterAddress"("token");

-- CreateIndex
CREATE INDEX "NewsletterAddress_userId_isActive_idx" ON "NewsletterAddress"("userId", "isActive");

-- CreateIndex
CREATE INDEX "NewsletterAddress_feedId_idx" ON "NewsletterAddress"("feedId");

-- AddForeignKey
ALTER TABLE "NewsletterAddress" ADD CONSTRAINT "NewsletterAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsletterAddress" ADD CONSTRAINT "NewsletterAddress_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsletterQuota" ADD CONSTRAINT "NewsletterQuota_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

