ALTER TABLE "GlobalSettings" ADD COLUMN "renderSidecarEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GlobalSettings" ADD COLUMN "renderSidecarUrl" TEXT;
ALTER TABLE "GlobalSettings" ADD COLUMN "renderSidecarToken" TEXT;
