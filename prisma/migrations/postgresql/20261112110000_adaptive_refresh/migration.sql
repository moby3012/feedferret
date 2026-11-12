ALTER TABLE "Feed" ADD COLUMN "nextSyncAt" TIMESTAMP(3);
ALTER TABLE "Feed" ADD COLUMN "cadenceMinutes" DOUBLE PRECISION;
CREATE INDEX "Feed_autoMuted_archivedAt_nextSyncAt_idx" ON "Feed"("autoMuted", "archivedAt", "nextSyncAt");
