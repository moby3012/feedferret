-- AlterTable: add auth, fetch options, and full-text extraction fields to Feed
ALTER TABLE "Feed" ADD COLUMN "authType" TEXT;
ALTER TABLE "Feed" ADD COLUMN "authUsername" TEXT;
ALTER TABLE "Feed" ADD COLUMN "authPassword" TEXT;
ALTER TABLE "Feed" ADD COLUMN "customUserAgent" TEXT;
ALTER TABLE "Feed" ADD COLUMN "fetchTimeoutSecs" INTEGER;
ALTER TABLE "Feed" ADD COLUMN "sslVerify" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Feed" ADD COLUMN "maxSizeKb" INTEGER;
ALTER TABLE "Feed" ADD COLUMN "fullTextSelector" TEXT;
ALTER TABLE "Feed" ADD COLUMN "fullTextRemoveSelectors" TEXT;
ALTER TABLE "Feed" ADD COLUMN "autoFetchFullText" BOOLEAN NOT NULL DEFAULT false;
