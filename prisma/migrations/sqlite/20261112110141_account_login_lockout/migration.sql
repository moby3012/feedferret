-- AlterTable
ALTER TABLE "User" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "failedLoginWindowEnd" DATETIME;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "failedApiLoginCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "failedApiLoginWindowEnd" DATETIME;
