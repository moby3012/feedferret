-- K2: catch-me-up briefing + daily AI token cap (lib/ai/usage.ts). Additive only.
-- Generated with `prisma migrate diff --from-schema <main> --to-schema prisma/schema.prisma --script`
-- (sqlite). Prisma emitted table redefinitions for "User" / "ArticleLabel" (new
-- columns sit mid-model); they are replaced here by the equivalent ADD COLUMNs,
-- like the earlier archival migrations. Archival only (see docs/database.md).

-- CreateTable
CREATE TABLE "Briefing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "windowStart" DATETIME NOT NULL,
    "windowEnd" DATETIME NOT NULL,
    "inputHash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "storyCount" INTEGER NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "seenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Briefing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'cloud',
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("userId", "day", "feature", "kind"),
    CONSTRAINT "AiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiBudgetDay" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "exhaustedAt" DATETIME,

    PRIMARY KEY ("userId", "day"),
    CONSTRAINT "AiBudgetDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "User" ADD COLUMN "aiDailyTokenCap" INTEGER;
ALTER TABLE "User" ADD COLUMN "briefingAuto" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ArticleLabel" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'user';

-- CreateIndex
CREATE INDEX "Briefing_userId_scopeKey_createdAt_idx" ON "Briefing"("userId", "scopeKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Briefing_userId_scopeKey_inputHash_model_promptVersion_key" ON "Briefing"("userId", "scopeKey", "inputHash", "model", "promptVersion");

