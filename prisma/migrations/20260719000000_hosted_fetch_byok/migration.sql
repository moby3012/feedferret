ALTER TABLE "User" ADD COLUMN "contentFetchProvider" TEXT;
ALTER TABLE "User" ADD COLUMN "contentFetchApiKey" TEXT;
ALTER TABLE "User" ADD COLUMN "contentFetchAutoUse" BOOLEAN NOT NULL DEFAULT false;
