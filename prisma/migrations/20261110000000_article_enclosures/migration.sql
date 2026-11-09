-- Retain feed attachment metadata for Google Reader compatible content responses.
ALTER TABLE "Article" ADD COLUMN "enclosures" TEXT;
