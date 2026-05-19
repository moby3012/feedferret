-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "feverKey" TEXT,
    "name" TEXT NOT NULL DEFAULT 'Default',
    "scope" TEXT NOT NULL DEFAULT 'write',
    "expiresAt" DATETIME,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateUniqueIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");
CREATE UNIQUE INDEX "ApiToken_feverKey_key" ON "ApiToken"("feverKey");

-- CreateIndex
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");

-- Migrate existing User.apiToken records to ApiToken table
INSERT INTO "ApiToken" ("id", "userId", "tokenHash", "name", "scope", "createdAt", "updatedAt")
SELECT 'mig_' || "id", "id", "apiToken", 'Default', 'write', "createdAt", datetime('now')
FROM "User"
WHERE "apiToken" IS NOT NULL;

-- RedefineTables (remove User.apiToken column by recreating User table)
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" DATETIME,
    "image" TEXT,
    "password" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "defaultUpdateFrequency" INTEGER NOT NULL DEFAULT 60,
    "defaultRetentionDays" INTEGER NOT NULL DEFAULT 90,
    "openOriginalByDefault" BOOLEAN NOT NULL DEFAULT false,
    "markReadAfterDelaySecs" INTEGER,
    "defaultViewMode" TEXT NOT NULL DEFAULT 'list',
    "readerWidth" TEXT NOT NULL DEFAULT 'normal',
    "readerFontSize" TEXT NOT NULL DEFAULT 'medium',
    "defaultArticleSort" TEXT NOT NULL DEFAULT 'newest',
    "accentColor" TEXT NOT NULL DEFAULT '#5BA4CF',
    "secondaryColor" TEXT NOT NULL DEFAULT '#F0963C',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "digestEnabled" BOOLEAN NOT NULL DEFAULT false,
    "digestFrequency" TEXT NOT NULL DEFAULT 'daily',
    "digestDayOfWeek" INTEGER,
    "digestHour" INTEGER NOT NULL DEFAULT 8,
    "digestScope" TEXT NOT NULL DEFAULT 'unread',
    "digestFeedIds" TEXT,
    "digestLastSentAt" DATETIME,
    "digestUnsubscribeToken" TEXT,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pushFrequency" TEXT NOT NULL DEFAULT 'immediate',
    "pushFeedIds" TEXT,
    "pushPrivatePayloads" BOOLEAN NOT NULL DEFAULT true,
    "pushLastSentAt" DATETIME,
    "telegramEnabled" BOOLEAN NOT NULL DEFAULT false,
    "telegramBotToken" TEXT,
    "telegramChatId" TEXT,
    "gotifyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "gotifyUrl" TEXT,
    "gotifyToken" TEXT,
    "ntfyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ntfyUrl" TEXT,
    "ntfyToken" TEXT,
    "hideDuplicates" BOOLEAN NOT NULL DEFAULT true,
    "markReadOnScroll" BOOLEAN NOT NULL DEFAULT false,
    "layoutDirection" TEXT NOT NULL DEFAULT 'ltr',
    "aiProvider" TEXT,
    "aiApiKey" TEXT,
    "aiModel" TEXT,
    "aiOllamaBaseUrl" TEXT,
    "aiAutoSummarize" BOOLEAN NOT NULL DEFAULT false,
    "aiSummaryLanguage" TEXT NOT NULL DEFAULT 'same',
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" SELECT "id","name","email","emailVerified","image","password","twoFactorEnabled","twoFactorSecret","sessionVersion","defaultUpdateFrequency","defaultRetentionDays","openOriginalByDefault","markReadAfterDelaySecs","defaultViewMode","readerWidth","readerFontSize","defaultArticleSort","accentColor","secondaryColor","isActive","digestEnabled","digestFrequency","digestDayOfWeek","digestHour","digestScope","digestFeedIds","digestLastSentAt","digestUnsubscribeToken","pushEnabled","pushFrequency","pushFeedIds","pushPrivatePayloads","pushLastSentAt","telegramEnabled","telegramBotToken","telegramChatId","gotifyEnabled","gotifyUrl","gotifyToken","ntfyEnabled","ntfyUrl","ntfyToken","hideDuplicates","markReadOnScroll","layoutDirection","aiProvider","aiApiKey","aiModel","aiOllamaBaseUrl","aiAutoSummarize","aiSummaryLanguage","role","createdAt","updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_digestUnsubscribeToken_key" ON "User"("digestUnsubscribeToken");
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
