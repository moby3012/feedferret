-- M5a: optional admin-configured RSSHub connector ("Add from platform").
ALTER TABLE "GlobalSettings" ADD COLUMN "rsshubEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GlobalSettings" ADD COLUMN "rsshubBaseUrl" TEXT;
ALTER TABLE "GlobalSettings" ADD COLUMN "rsshubApiKey" TEXT;
