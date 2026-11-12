-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mediaProxyImages" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "GlobalSettings" ADD COLUMN     "mediaProxyMode" TEXT NOT NULL DEFAULT 'off';

