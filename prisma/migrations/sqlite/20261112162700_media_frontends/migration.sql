-- Additive preferences only; avoid a SQLite User table rebuild.
ALTER TABLE "User" ADD COLUMN "mediaYoutubeInstance" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "mediaRedditFrontend" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "mediaTwitterInstance" TEXT NOT NULL DEFAULT '';
