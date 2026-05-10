-- AlterTable: add reading preference fields to User
ALTER TABLE "User" ADD COLUMN "markReadAfterDelaySecs" INTEGER;
ALTER TABLE "User" ADD COLUMN "defaultViewMode" TEXT NOT NULL DEFAULT 'list';
ALTER TABLE "User" ADD COLUMN "readerWidth" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "User" ADD COLUMN "defaultArticleSort" TEXT NOT NULL DEFAULT 'newest';
