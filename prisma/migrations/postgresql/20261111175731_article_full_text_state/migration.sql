-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "feedContent" TEXT,
ADD COLUMN     "fullTextAttempts" INTEGER,
ADD COLUMN     "fullTextFetchedAt" TIMESTAMP(3),
ADD COLUMN     "fullTextReason" TEXT,
ADD COLUMN     "fullTextStatus" TEXT;

