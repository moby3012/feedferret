-- AutoReadRule.trigger: "article" (existing) or "feed_error" (fires on feed sync failure)
ALTER TABLE "AutoReadRule" ADD COLUMN "trigger" TEXT NOT NULL DEFAULT 'article';

CREATE INDEX "AutoReadRule_userId_trigger_enabled_idx" ON "AutoReadRule"("userId", "trigger", "enabled");
