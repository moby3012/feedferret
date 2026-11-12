ALTER TABLE "Feed" ADD COLUMN "nextSyncAt" DATETIME;
ALTER TABLE "Feed" ADD COLUMN "cadenceMinutes" REAL;
CREATE INDEX "Feed_autoMuted_archivedAt_nextSyncAt_idx" ON "Feed"("autoMuted", "archivedAt", "nextSyncAt");
