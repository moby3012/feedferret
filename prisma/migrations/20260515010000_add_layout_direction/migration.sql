-- User: persisted preference for left-to-right vs right-to-left layout.
ALTER TABLE "User" ADD COLUMN "layoutDirection" TEXT NOT NULL DEFAULT 'ltr';
