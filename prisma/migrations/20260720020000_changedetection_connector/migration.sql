-- M5b: optional admin-configured changedetection.io connector ("Monitor this page").
ALTER TABLE "GlobalSettings" ADD COLUMN "changedetectionEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GlobalSettings" ADD COLUMN "changedetectionBaseUrl" TEXT;
ALTER TABLE "GlobalSettings" ADD COLUMN "changedetectionApiKey" TEXT;
ALTER TABLE "GlobalSettings" ADD COLUMN "changedetectionRssToken" TEXT;
