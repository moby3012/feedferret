-- Per-user display timezone for every timestamp shown in the app (article
-- dates, reader, etc.) — distinct from digestTimezone, which only affects
-- when the email digest is sent. null = auto-detect from the browser.
ALTER TABLE "User" ADD COLUMN "displayTimezone" TEXT;
