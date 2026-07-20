-- F5: export destinations ("send to" Obsidian / Wallabag) from the article reader.
ALTER TABLE "User" ADD COLUMN "exportObsidianVault" TEXT;
ALTER TABLE "User" ADD COLUMN "exportWallabagUrl" TEXT;
ALTER TABLE "User" ADD COLUMN "exportWallabagClientId" TEXT;
ALTER TABLE "User" ADD COLUMN "exportWallabagClientSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "exportWallabagUsername" TEXT;
ALTER TABLE "User" ADD COLUMN "exportWallabagPassword" TEXT;

-- F6: auto-mute + notify on persistently-failing feeds.
ALTER TABLE "User" ADD COLUMN "autoMuteFailingFeedsAfter" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "Feed" ADD COLUMN "consecutiveFailureCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Feed" ADD COLUMN "autoMuted" BOOLEAN NOT NULL DEFAULT false;
