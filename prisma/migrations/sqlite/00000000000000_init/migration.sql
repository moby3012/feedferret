-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" DATETIME,
    "image" TEXT,
    "password" TEXT,
    "apiPasswordHash" TEXT,
    "apiPasswordCreatedAt" DATETIME,
    "apiPasswordLastUsedAt" DATETIME,
    "apiPasswordRequired" BOOLEAN NOT NULL DEFAULT false,
    "apiTokenVersion" INTEGER NOT NULL DEFAULT 0,
    "apiFeverKey" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorLastAcceptedStep" INTEGER,
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
    "digestTimezone" TEXT NOT NULL DEFAULT 'UTC',
    "digestScope" TEXT NOT NULL DEFAULT 'unread',
    "digestFeedIds" TEXT,
    "digestMaxArticles" INTEGER NOT NULL DEFAULT 20,
    "digestMinArticles" INTEGER NOT NULL DEFAULT 1,
    "digestLookbackHours" INTEGER,
    "digestGroupByFeed" BOOLEAN NOT NULL DEFAULT false,
    "digestAiSummary" TEXT NOT NULL DEFAULT 'none',
    "digestSkipFeatured" BOOLEAN NOT NULL DEFAULT false,
    "digestLabelIds" TEXT,
    "digestPausedUntil" DATETIME,
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
    "storyClustering" BOOLEAN NOT NULL DEFAULT true,
    "clusterReadMode" TEXT NOT NULL DEFAULT 'story',
    "markReadOnScroll" BOOLEAN NOT NULL DEFAULT false,
    "markReadOnAdvance" BOOLEAN NOT NULL DEFAULT false,
    "layoutDirection" TEXT NOT NULL DEFAULT 'ltr',
    "hideEmptyFeeds" BOOLEAN NOT NULL DEFAULT false,
    "hideEmptyLabels" BOOLEAN NOT NULL DEFAULT false,
    "countDisplay" TEXT DEFAULT 'all',
    "uiLanguage" TEXT NOT NULL DEFAULT 'en',
    "displayTimezone" TEXT,
    "aiProvider" TEXT,
    "aiApiKey" TEXT,
    "aiModel" TEXT,
    "aiOllamaBaseUrl" TEXT,
    "aiAutoSummarize" BOOLEAN NOT NULL DEFAULT false,
    "aiSummaryLanguage" TEXT NOT NULL DEFAULT 'same',
    "aiAutoTag" BOOLEAN NOT NULL DEFAULT false,
    "aiCleanTitles" BOOLEAN NOT NULL DEFAULT false,
    "aiDailyTokenCap" INTEGER,
    "briefingAuto" BOOLEAN NOT NULL DEFAULT true,
    "contentFetchProvider" TEXT,
    "contentFetchApiKey" TEXT,
    "contentFetchAutoUse" BOOLEAN NOT NULL DEFAULT false,
    "autoMuteFailingFeedsAfter" INTEGER NOT NULL DEFAULT 10,
    "exportObsidianVault" TEXT,
    "exportWallabagUrl" TEXT,
    "exportWallabagClientId" TEXT,
    "exportWallabagClientSecret" TEXT,
    "exportWallabagUsername" TEXT,
    "exportWallabagPassword" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "platform" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME,
    "disabledAt" DATETIME,
    CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutoReadRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actions" TEXT,
    "scope" TEXT,
    "trigger" TEXT NOT NULL DEFAULT 'article',
    "webhookConfigs" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "lastTriggeredAt" DATETIME,
    "removeSpoilerOnDelete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutoReadRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KeywordAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "actions" TEXT NOT NULL DEFAULT '["notify_inapp"]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastTriggeredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "KeywordAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "articleId" TEXT,
    "feedId" TEXT,
    "alertId" TEXT,
    "ruleId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "KeywordAlert" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutoReadRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GReaderPreference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GReaderPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Category" (
    "extId" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "opmlUrl" TEXT,
    "updateFrequency" INTEGER,
    "hideFromAllFeeds" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Category_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Feed" (
    "extId" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'rss',
    "htmlUrl" TEXT,
    "description" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'main',
    "unicityCriteria" TEXT NOT NULL DEFAULT 'id',
    "unicityCriteriaForced" BOOLEAN NOT NULL DEFAULT false,
    "scraperConfig" TEXT,
    "httpOptions" TEXT,
    "userId" TEXT NOT NULL,
    "categoryId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "updateFrequency" INTEGER,
    "retentionDays" INTEGER,
    "keepMinArticles" INTEGER,
    "lastFetchedAt" DATETIME,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "consecutiveFailureCount" INTEGER NOT NULL DEFAULT 0,
    "autoMuted" BOOLEAN NOT NULL DEFAULT false,
    "etag" TEXT,
    "lastModifiedHeader" TEXT,
    "authType" TEXT,
    "authUsername" TEXT,
    "authPassword" TEXT,
    "customUserAgent" TEXT,
    "fetchTimeoutSecs" INTEGER,
    "sslVerify" BOOLEAN NOT NULL DEFAULT true,
    "maxSizeKb" INTEGER,
    "fullTextSelector" TEXT,
    "fullTextRemoveSelectors" TEXT,
    "autoFetchFullText" BOOLEAN NOT NULL DEFAULT false,
    "fullTextConditions" TEXT,
    "fullTextMode" TEXT NOT NULL DEFAULT 'off',
    "defaultContentFormat" TEXT NOT NULL DEFAULT 'html',
    "fullTextAutoSuggestDismissed" BOOLEAN NOT NULL DEFAULT false,
    "filtersActionRead" TEXT,
    "hideFromAllFeeds" BOOLEAN NOT NULL DEFAULT false,
    "hideArticleImage" BOOLEAN NOT NULL DEFAULT false,
    "readerFontSizeOverride" TEXT,
    "readerWidthOverride" TEXT,
    "openOriginalOverride" BOOLEAN,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Feed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Feed_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Article" (
    "extId" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "feedId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "externalId" TEXT,
    "dedupeKey" TEXT,
    "contentHash" TEXT,
    "isDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "duplicateOf" TEXT,
    "content" TEXT NOT NULL,
    "contentFormat" TEXT NOT NULL DEFAULT 'html',
    "excerpt" TEXT,
    "author" TEXT,
    "publishedAt" DATETIME NOT NULL,
    "enclosures" TEXT,
    "imageUrl" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" DATETIME,
    "isStarred" BOOLEAN NOT NULL DEFAULT false,
    "isReadLater" BOOLEAN NOT NULL DEFAULT false,
    "readLaterSavedAt" DATETIME,
    "isSpoiler" BOOLEAN NOT NULL DEFAULT false,
    "spoilerAt" DATETIME,
    "spoilerRuleId" TEXT,
    "aiSummary" TEXT,
    "aiSummarizedAt" DATETIME,
    "aiTaggedAt" DATETIME,
    "entities" TEXT,
    "isSponsored" BOOLEAN,
    "isClickbait" BOOLEAN,
    "cleanTitle" TEXT,
    "enrichSource" TEXT,
    "digestedAt" DATETIME,
    "kind" TEXT,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "mediaDurationSecs" INTEGER,
    "readMinutes" INTEGER,
    "clusterId" TEXT,
    "storySig" TEXT,
    "clusteredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Article_duplicateOf_fkey" FOREIGN KEY ("duplicateOf") REFERENCES "Article" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Article_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Article_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Article_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "StoryCluster" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StoryCluster" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "leadArticleId" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 2,
    "feedCount" INTEGER NOT NULL DEFAULT 2,
    "firstSeenAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL,
    "sig" TEXT NOT NULL,
    "algoVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoryCluster_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Briefing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "windowStart" DATETIME NOT NULL,
    "windowEnd" DATETIME NOT NULL,
    "inputHash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "storyCount" INTEGER NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "seenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Briefing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'cloud',
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("userId", "day", "feature", "kind"),
    CONSTRAINT "AiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiBudgetDay" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "exhaustedAt" DATETIME,

    PRIMARY KEY ("userId", "day"),
    CONSTRAINT "AiBudgetDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Label" (
    "extId" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#3b82f6',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Label_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ArticleLabel" (
    "articleId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'user',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("articleId", "labelId"),
    CONSTRAINT "ArticleLabel_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArticleLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SavedSearch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "shareToken" TEXT,
    "sharedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SavedSearch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GlobalSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "registrationsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mailServiceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mailProvider" TEXT NOT NULL DEFAULT 'smtp',
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpUser" TEXT,
    "smtpPassword" TEXT,
    "smtpFrom" TEXT,
    "smtpSecure" TEXT,
    "smtpRejectUnauthorized" BOOLEAN,
    "resendApiKey" TEXT,
    "resendFromEmail" TEXT,
    "postmarkServerToken" TEXT,
    "postmarkFromEmail" TEXT,
    "postmarkMessageStream" TEXT,
    "mailgunApiKey" TEXT,
    "mailgunDomain" TEXT,
    "mailgunFromEmail" TEXT,
    "mailgunBaseUrl" TEXT,
    "sendgridApiKey" TEXT,
    "sendgridFromEmail" TEXT,
    "instanceName" TEXT,
    "instanceUrl" TEXT,
    "instanceIconDataUrl" TEXT,
    "starterPacksJson" TEXT,
    "totpIssuer" TEXT,
    "backgroundSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "backgroundSyncIntervalMinutes" INTEGER NOT NULL DEFAULT 5,
    "allowInternalFeedUrls" BOOLEAN NOT NULL DEFAULT false,
    "renderSidecarEnabled" BOOLEAN NOT NULL DEFAULT false,
    "renderSidecarUrl" TEXT,
    "renderSidecarToken" TEXT,
    "rsshubEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rsshubBaseUrl" TEXT,
    "rsshubApiKey" TEXT,
    "changedetectionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "changedetectionBaseUrl" TEXT,
    "changedetectionApiKey" TEXT,
    "changedetectionRssToken" TEXT,
    "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "require2FAForAdmins" BOOLEAN NOT NULL DEFAULT false,
    "disablePublicSharedSearches" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

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
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "userId" TEXT,
    "success" BOOLEAN NOT NULL,
    "failReason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "targetEmail" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DiscoveryCatalogFeed" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "iconUrl" TEXT,
    "popularity" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ExternalIdSequence" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "value" BIGINT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_apiFeverKey_key" ON "User"("apiFeverKey");

-- CreateIndex
CREATE UNIQUE INDEX "User_digestUnsubscribeToken_key" ON "User"("digestUnsubscribeToken");

-- CreateIndex
CREATE INDEX "User_digestEnabled_idx" ON "User"("digestEnabled");

-- CreateIndex
CREATE INDEX "User_pushEnabled_idx" ON "User"("pushEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_disabledAt_idx" ON "PushSubscription"("userId", "disabledAt");

-- CreateIndex
CREATE INDEX "AutoReadRule_userId_enabled_order_idx" ON "AutoReadRule"("userId", "enabled", "order");

-- CreateIndex
CREATE INDEX "AutoReadRule_userId_trigger_enabled_idx" ON "AutoReadRule"("userId", "trigger", "enabled");

-- CreateIndex
CREATE INDEX "KeywordAlert_userId_enabled_idx" ON "KeywordAlert"("userId", "enabled");

-- CreateIndex
CREATE INDEX "KeywordAlert_userId_scope_idx" ON "KeywordAlert"("userId", "scope");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_articleId_idx" ON "Notification"("articleId");

-- CreateIndex
CREATE INDEX "Notification_alertId_idx" ON "Notification"("alertId");

-- CreateIndex
CREATE INDEX "Notification_ruleId_idx" ON "Notification"("ruleId");

-- CreateIndex
CREATE INDEX "Notification_feedId_idx" ON "Notification"("feedId");

-- CreateIndex
CREATE INDEX "GReaderPreference_userId_streamId_idx" ON "GReaderPreference"("userId", "streamId");

-- CreateIndex
CREATE UNIQUE INDEX "GReaderPreference_userId_streamId_key_key" ON "GReaderPreference"("userId", "streamId", "key");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Category_extId_key" ON "Category"("extId");

-- CreateIndex
CREATE INDEX "Category_userId_idx" ON "Category"("userId");

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_userId_name_parentId_key" ON "Category"("userId", "name", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Feed_extId_key" ON "Feed"("extId");

-- CreateIndex
CREATE INDEX "Feed_userId_idx" ON "Feed"("userId");

-- CreateIndex
CREATE INDEX "Feed_categoryId_idx" ON "Feed"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Feed_userId_url_key" ON "Feed"("userId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "Article_extId_key" ON "Article"("extId");

-- CreateIndex
CREATE INDEX "Article_userId_createdAt_id_idx" ON "Article"("userId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Article_userId_contentHash_idx" ON "Article"("userId", "contentHash");

-- CreateIndex
CREATE INDEX "Article_userId_isRead_publishedAt_idx" ON "Article"("userId", "isRead", "publishedAt");

-- CreateIndex
CREATE INDEX "Article_userId_isStarred_publishedAt_idx" ON "Article"("userId", "isStarred", "publishedAt");

-- CreateIndex
CREATE INDEX "Article_userId_isReadLater_readLaterSavedAt_idx" ON "Article"("userId", "isReadLater", "readLaterSavedAt");

-- CreateIndex
CREATE INDEX "Article_userId_isSpoiler_publishedAt_idx" ON "Article"("userId", "isSpoiler", "publishedAt");

-- CreateIndex
CREATE INDEX "Article_userId_readAt_idx" ON "Article"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Article_feedId_publishedAt_createdAt_id_idx" ON "Article"("feedId", "publishedAt" DESC, "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Article_spoilerRuleId_idx" ON "Article"("spoilerRuleId");

-- CreateIndex
CREATE INDEX "Article_userId_digestedAt_idx" ON "Article"("userId", "digestedAt");

-- CreateIndex
CREATE INDEX "Article_userId_isSponsored_idx" ON "Article"("userId", "isSponsored");

-- CreateIndex
CREATE INDEX "Article_userId_publishedAt_createdAt_id_idx" ON "Article"("userId", "publishedAt" DESC, "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Article_userId_isRead_isSpoiler_feedId_idx" ON "Article"("userId", "isRead", "isSpoiler", "feedId");

-- CreateIndex
CREATE INDEX "Article_duplicateOf_idx" ON "Article"("duplicateOf");

-- CreateIndex
CREATE INDEX "Article_userId_clusterId_idx" ON "Article"("userId", "clusterId");

-- CreateIndex
CREATE INDEX "Article_clusterId_idx" ON "Article"("clusterId");

-- CreateIndex
CREATE INDEX "Article_userId_clusteredAt_publishedAt_idx" ON "Article"("userId", "clusteredAt", "publishedAt");

-- CreateIndex
CREATE INDEX "Article_userId_feedId_createdAt_idx" ON "Article"("userId", "feedId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Article_userId_feedId_dedupeKey_key" ON "Article"("userId", "feedId", "dedupeKey");

-- CreateIndex
CREATE INDEX "StoryCluster_userId_lastSeenAt_idx" ON "StoryCluster"("userId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "Briefing_userId_scopeKey_createdAt_idx" ON "Briefing"("userId", "scopeKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Briefing_userId_scopeKey_inputHash_model_promptVersion_key" ON "Briefing"("userId", "scopeKey", "inputHash", "model", "promptVersion");

-- CreateIndex
CREATE UNIQUE INDEX "Label_extId_key" ON "Label"("extId");

-- CreateIndex
CREATE INDEX "Label_userId_idx" ON "Label"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Label_userId_name_key" ON "Label"("userId", "name");

-- CreateIndex
CREATE INDEX "ArticleLabel_labelId_idx" ON "ArticleLabel"("labelId");

-- CreateIndex
CREATE INDEX "ArticleLabel_userId_idx" ON "ArticleLabel"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedSearch_shareToken_key" ON "SavedSearch"("shareToken");

-- CreateIndex
CREATE INDEX "SavedSearch_userId_order_idx" ON "SavedSearch"("userId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "SavedSearch_userId_name_key" ON "SavedSearch"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_feverKey_key" ON "ApiToken"("feverKey");

-- CreateIndex
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");

-- CreateIndex
CREATE INDEX "LoginAttempt_email_createdAt_idx" ON "LoginAttempt"("email", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_createdAt_idx" ON "LoginAttempt"("createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_actorId_createdAt_idx" ON "AdminAuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "SystemLog_category_createdAt_idx" ON "SystemLog"("category", "createdAt");

-- CreateIndex
CREATE INDEX "SystemLog_createdAt_idx" ON "SystemLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveryCatalogFeed_url_key" ON "DiscoveryCatalogFeed"("url");

-- CreateIndex
CREATE INDEX "DiscoveryCatalogFeed_category_enabled_popularity_idx" ON "DiscoveryCatalogFeed"("category", "enabled", "popularity");

-- CreateIndex
CREATE INDEX "DiscoveryCatalogFeed_language_enabled_idx" ON "DiscoveryCatalogFeed"("language", "enabled");

