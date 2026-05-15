-- AutoReadRule: add multi-action support, optional scope, last-triggered timestamp
ALTER TABLE "AutoReadRule" ADD COLUMN "actions" TEXT;
ALTER TABLE "AutoReadRule" ADD COLUMN "scope" TEXT;
ALTER TABLE "AutoReadRule" ADD COLUMN "lastTriggeredAt" DATETIME;

-- Notification: allow attribution to AutoReadRule (was only KeywordAlert)
ALTER TABLE "Notification" ADD COLUMN "ruleId" TEXT REFERENCES "AutoReadRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Notification_ruleId_idx" ON "Notification"("ruleId");
