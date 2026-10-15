-- AlterTable
ALTER TABLE "user_settings" ADD COLUMN "channelStyleNotes" TEXT;

-- CreateTable
CREATE TABLE "packaging_set" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "videoId" TEXT,
    "shortId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "error" TEXT,
    "inputNotes" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "titlesJson" TEXT NOT NULL DEFAULT '[]',
    "description" TEXT NOT NULL DEFAULT '',
    "hashtagsJson" TEXT NOT NULL DEFAULT '[]',
    "hooksJson" TEXT NOT NULL DEFAULT '[]',
    "thumbnailConceptsJson" TEXT NOT NULL DEFAULT '[]',
    "chaptersJson" TEXT NOT NULL DEFAULT '[]',
    "warningsJson" TEXT NOT NULL DEFAULT '[]',
    "generatedJson" TEXT,
    "selectedTitle" INTEGER NOT NULL DEFAULT 0,
    "selectedHook" INTEGER NOT NULL DEFAULT 0,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "savedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "packaging_set_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "packaging_set_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "packaging_set_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "short" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "thumbnail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "videoId" TEXT,
    "shortId" TEXT,
    "packagingSetId" TEXT,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "error" TEXT,
    "filePath" TEXT,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sizeBytes" INTEGER,
    "sourceFrameMs" INTEGER,
    "headline" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "thumbnail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "thumbnail_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "thumbnail_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "short" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "thumbnail_packagingSetId_fkey" FOREIGN KEY ("packagingSetId") REFERENCES "packaging_set" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "packaging_set_videoId_createdAt_idx" ON "packaging_set"("videoId", "createdAt");

-- CreateIndex
CREATE INDEX "packaging_set_shortId_createdAt_idx" ON "packaging_set"("shortId", "createdAt");

-- CreateIndex
CREATE INDEX "packaging_set_userId_updatedAt_idx" ON "packaging_set"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "thumbnail_videoId_createdAt_idx" ON "thumbnail"("videoId", "createdAt");

-- CreateIndex
CREATE INDEX "thumbnail_shortId_createdAt_idx" ON "thumbnail"("shortId", "createdAt");
