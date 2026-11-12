-- AlterTable
ALTER TABLE "User" ADD COLUMN     "failedApiLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failedApiLoginWindowEnd" TIMESTAMP(3),
ADD COLUMN     "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failedLoginWindowEnd" TIMESTAMP(3);
