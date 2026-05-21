-- Add uiLanguage user preference for interface language selection.
-- BCP-47 tag (e.g. "en", "de"). Defaults to "en" for existing users.
ALTER TABLE "User" ADD COLUMN "uiLanguage" TEXT NOT NULL DEFAULT 'en';
