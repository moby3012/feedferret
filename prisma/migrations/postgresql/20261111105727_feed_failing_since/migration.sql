-- AlterTable
ALTER TABLE "Feed" ADD COLUMN     "failingSince" TIMESTAMP(3),
ADD COLUMN     "lastSuccessAt" TIMESTAMP(3);
