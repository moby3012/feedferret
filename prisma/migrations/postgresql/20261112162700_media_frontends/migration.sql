-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mediaRedditFrontend" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "mediaTwitterInstance" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "mediaYoutubeFrontend" TEXT NOT NULL DEFAULT 'invidious',
ADD COLUMN     "mediaYoutubeInstance" TEXT NOT NULL DEFAULT '';

