-- ff:allow-destructive Initialize only the newly added nextSyncAt column with deployment jitter; existing content is untouched.
-- Additive AutoTTL metadata. Scatter existing subscriptions across the first 15 minutes.
ALTER TABLE "Feed" ADD COLUMN "nextSyncAt" TIMESTAMP(3);
ALTER TABLE "Feed" ADD COLUMN "cadenceMinutes" DOUBLE PRECISION;
UPDATE "Feed" SET "nextSyncAt" = CURRENT_TIMESTAMP + (1 + random() * 900) * interval '1 second';
CREATE INDEX "Feed_autoMuted_archivedAt_nextSyncAt_idx" ON "Feed"("autoMuted", "archivedAt", "nextSyncAt");
