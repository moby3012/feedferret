-- AlterTable
ALTER TABLE "Feed" ADD COLUMN "failingSince" DATETIME;
ALTER TABLE "Feed" ADD COLUMN "lastSuccessAt" DATETIME;
