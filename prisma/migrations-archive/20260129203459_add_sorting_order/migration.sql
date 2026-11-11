-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "updateFrequency" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Category_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Category" ("createdAt", "id", "name", "parentId", "updateFrequency", "updatedAt", "userId") SELECT "createdAt", "id", "name", "parentId", "updateFrequency", "updatedAt", "userId" FROM "Category";
DROP TABLE "Category";
ALTER TABLE "new_Category" RENAME TO "Category";
CREATE UNIQUE INDEX "Category_userId_name_parentId_key" ON "Category"("userId", "name", "parentId");
CREATE TABLE "new_Feed" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "userId" TEXT NOT NULL,
    "categoryId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "updateFrequency" INTEGER,
    "lastFetchedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Feed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Feed_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Feed" ("categoryId", "createdAt", "icon", "id", "lastFetchedAt", "name", "updateFrequency", "updatedAt", "url", "userId") SELECT "categoryId", "createdAt", "icon", "id", "lastFetchedAt", "name", "updateFrequency", "updatedAt", "url", "userId" FROM "Feed";
DROP TABLE "Feed";
ALTER TABLE "new_Feed" RENAME TO "Feed";
CREATE UNIQUE INDEX "Feed_userId_url_key" ON "Feed"("userId", "url");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
