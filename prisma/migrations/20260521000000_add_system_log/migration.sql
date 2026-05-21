CREATE TABLE "SystemLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "level" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SystemLog_category_createdAt_idx" ON "SystemLog"("category", "createdAt");
CREATE INDEX "SystemLog_createdAt_idx" ON "SystemLog"("createdAt");
