-- Track which rule set the spoiler flag so it can be cleared on rule deletion.
ALTER TABLE "Article" ADD COLUMN "spoilerRuleId" TEXT;
CREATE INDEX "Article_spoilerRuleId_idx" ON "Article"("spoilerRuleId");

-- Option on AutoReadRule: clear spoiler flag from flagged articles when this rule is deleted.
ALTER TABLE "AutoReadRule" ADD COLUMN "removeSpoilerOnDelete" BOOLEAN NOT NULL DEFAULT false;
