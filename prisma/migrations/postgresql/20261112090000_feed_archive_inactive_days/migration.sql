-- AlterTable
ALTER TABLE "User" ADD COLUMN     "inactiveFeedDays" INTEGER NOT NULL DEFAULT 180;

-- AlterTable
ALTER TABLE "Feed" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Feed_userId_archivedAt_idx" ON "Feed"("userId", "archivedAt");

