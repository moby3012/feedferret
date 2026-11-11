-- GReader unread-count perf (audit R6): newest article per feed as a covering index scan.
-- Additive only; archival (the runtime applies the schema with `prisma db push`, see docs/database.md).
CREATE INDEX "Article_userId_feedId_createdAt_idx" ON "Article"("userId", "feedId", "createdAt");
