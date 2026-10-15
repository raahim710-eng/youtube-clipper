-- CreateTable
CREATE TABLE "generator_project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "audience" TEXT,
    "tone" TEXT NOT NULL,
    "notes" TEXT,
    "targetDurationSec" INTEGER NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "resolution" INTEGER NOT NULL DEFAULT 1080,
    "language" TEXT NOT NULL DEFAULT 'English',
    "voice" TEXT,
    "voiceRate" INTEGER NOT NULL DEFAULT 0,
    "captionsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "quality" TEXT NOT NULL DEFAULT 'standard',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "error" TEXT,
    "title" TEXT,
    "hook" TEXT,
    "scriptProvider" TEXT,
    "scriptModel" TEXT,
    "scriptWarningsJson" TEXT NOT NULL DEFAULT '[]',
    "scriptApprovedAt" DATETIME,
    "musicPath" TEXT,
    "musicVolumeDb" INTEGER NOT NULL DEFAULT -18,
    "outputVideoId" TEXT,
    "creditsText" TEXT,
    "renderElapsedMs" INTEGER,
    "renderedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "generator_project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "generator_project_outputVideoId_fkey" FOREIGN KEY ("outputVideoId") REFERENCES "video" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "generator_scene" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "narration" TEXT NOT NULL,
    "visualQuery" TEXT NOT NULL,
    "onScreenText" TEXT,
    "estimatedMs" INTEGER,
    "narrationStatus" TEXT NOT NULL DEFAULT 'none',
    "narrationError" TEXT,
    "audioPath" TEXT,
    "audioDurationMs" INTEGER,
    "wordTimingsJson" TEXT,
    "timingSource" TEXT,
    "narratedText" TEXT,
    "footageSource" TEXT,
    "footageStatus" TEXT NOT NULL DEFAULT 'none',
    "footageError" TEXT,
    "stockAssetId" TEXT,
    "candidatesJson" TEXT NOT NULL DEFAULT '[]',
    "libraryVideoId" TEXT,
    "customClipPath" TEXT,
    "clipStartMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "generator_scene_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "generator_project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "generator_scene_stockAssetId_fkey" FOREIGN KEY ("stockAssetId") REFERENCES "stock_asset" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "generator_scene_libraryVideoId_fkey" FOREIGN KEY ("libraryVideoId") REFERENCES "video" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stock_asset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "providerAssetId" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "creatorName" TEXT NOT NULL,
    "creatorUrl" TEXT,
    "downloadUrl" TEXT NOT NULL,
    "previewImageUrl" TEXT,
    "filePath" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "licenseName" TEXT NOT NULL,
    "downloadedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "generator_project_outputVideoId_key" ON "generator_project"("outputVideoId");

-- CreateIndex
CREATE INDEX "generator_project_userId_updatedAt_idx" ON "generator_project"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "generator_scene_projectId_order_idx" ON "generator_scene"("projectId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "stock_asset_provider_providerAssetId_key" ON "stock_asset"("provider", "providerAssetId");
