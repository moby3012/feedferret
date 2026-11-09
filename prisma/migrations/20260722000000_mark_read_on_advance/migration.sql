-- "Beim Weitergehen als gelesen markieren": the end-of-list "Weiter zu …" button
-- also marks the current view read. Default off.
ALTER TABLE "User" ADD COLUMN "markReadOnAdvance" BOOLEAN NOT NULL DEFAULT false;
