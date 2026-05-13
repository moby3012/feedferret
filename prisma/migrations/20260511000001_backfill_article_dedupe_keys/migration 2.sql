-- Existing articles predate FreshRSS-style dedupe keys. Use link as the initial stable key.
UPDATE "Article"
SET "dedupeKey" = COALESCE(NULLIF("externalId", ''), NULLIF("link", ''), "id")
WHERE "dedupeKey" IS NULL;
