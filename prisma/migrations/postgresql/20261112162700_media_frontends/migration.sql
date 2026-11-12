-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mediaRedditFrontend" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "mediaTwitterInstance" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "mediaYoutubeInstance" TEXT NOT NULL DEFAULT '';

