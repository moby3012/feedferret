-- Add hideEmptyFeeds user preference (was missing from api_token_model migration).
ALTER TABLE "User" ADD COLUMN "hideEmptyFeeds" BOOLEAN NOT NULL DEFAULT false;

-- Add hideEmptyLabels user preference for hiding labels with no unread articles from the sidebar.
ALTER TABLE "User" ADD COLUMN "hideEmptyLabels" BOOLEAN NOT NULL DEFAULT false;
