-- AlterTable
ALTER TABLE "Article" ADD COLUMN "feedContent" TEXT;
ALTER TABLE "Article" ADD COLUMN "fullTextAttempts" INTEGER;
ALTER TABLE "Article" ADD COLUMN "fullTextFetchedAt" DATETIME;
ALTER TABLE "Article" ADD COLUMN "fullTextReason" TEXT;
ALTER TABLE "Article" ADD COLUMN "fullTextStatus" TEXT;

