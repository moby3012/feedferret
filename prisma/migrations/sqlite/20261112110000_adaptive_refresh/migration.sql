-- ff:allow-destructive Initialize only the newly added nextSyncAt column with deployment jitter; existing content is untouched.
-- Additive AutoTTL metadata. Scatter existing subscriptions across the first 15 minutes.
ALTER TABLE "Feed" ADD COLUMN "nextSyncAt" DATETIME;
ALTER TABLE "Feed" ADD COLUMN "cadenceMinutes" REAL;
UPDATE "Feed" SET "nextSyncAt" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 1000 + abs(random() % 900000);
CREATE INDEX "Feed_autoMuted_archivedAt_nextSyncAt_idx" ON "Feed"("autoMuted", "archivedAt", "nextSyncAt");
