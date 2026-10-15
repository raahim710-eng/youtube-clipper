-- AlterTable
ALTER TABLE "user_settings" ADD COLUMN "defaultChannelId" TEXT;

-- CreateTable
CREATE TABLE "youtube_channel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "youtubeChannelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "thumbnailUrl" TEXT,
    "uploadsPlaylistId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "grantedScopes" TEXT NOT NULL,
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "youtube_channel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oauth_credential" (
    "channelId" TEXT NOT NULL PRIMARY KEY,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "accessTokenExpiresAt" DATETIME NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "oauth_credential_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "youtube_channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "publication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "videoId" TEXT,
    "shortId" TEXT,
    "thumbnailId" TEXT,
    "sourceTitle" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tagsJson" TEXT NOT NULL DEFAULT '[]',
    "categoryId" TEXT NOT NULL,
    "privacyStatus" TEXT NOT NULL,
    "actualPrivacyStatus" TEXT,
    "publishAt" DATETIME,
    "madeForKids" BOOLEAN NOT NULL,
    "containsSyntheticMedia" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "uploadProgress" INTEGER NOT NULL DEFAULT 0,
    "bytesUploaded" BIGINT NOT NULL DEFAULT 0,
    "uploadSessionEnc" TEXT,
    "youtubeVideoId" TEXT,
    "error" TEXT,
    "warningsJson" TEXT NOT NULL DEFAULT '[]',
    "uploadedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "publication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "publication_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "youtube_channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "publication_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "publication_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "short" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "publication_thumbnailId_fkey" FOREIGN KEY ("thumbnailId") REFERENCES "thumbnail" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "api_quota_usage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectDate" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "youtube_channel_youtubeChannelId_key" ON "youtube_channel"("youtubeChannelId");

-- CreateIndex
CREATE INDEX "youtube_channel_userId_idx" ON "youtube_channel"("userId");

-- CreateIndex
CREATE INDEX "publication_userId_createdAt_idx" ON "publication"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "publication_channelId_idx" ON "publication"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "api_quota_usage_projectDate_bucket_key" ON "api_quota_usage"("projectDate", "bucket");
