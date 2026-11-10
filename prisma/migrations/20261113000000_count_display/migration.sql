-- PR 9 anti-anxiety (spec §4.9.3): where unread numbers show. Additive only;
-- null / "all" = today's behaviour. Archival only (see docs/database.md).
ALTER TABLE "User" ADD COLUMN "countDisplay" TEXT DEFAULT 'all';
