-- AlterTable
ALTER TABLE "user_settings" ADD COLUMN "captionStyleJson" TEXT;

-- CreateTable
CREATE TABLE "short" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "clipCandidateId" TEXT,
    "title" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "reframeMode" TEXT NOT NULL DEFAULT 'auto',
    "manualX" REAL NOT NULL DEFAULT 0.5,
    "reframeStatus" TEXT NOT NULL DEFAULT 'none',
    "reframeError" TEXT,
    "reframeJson" TEXT,
    "captionsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "captionsJson" TEXT NOT NULL DEFAULT '[]',
    "captionStyleJson" TEXT NOT NULL,
    "hookText" TEXT,
    "exportQuality" TEXT NOT NULL DEFAULT 'standard',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "renderError" TEXT,
    "outputPath" TEXT,
    "outputSizeBytes" BIGINT,
    "outputDurationMs" INTEGER,
    "renderSignature" TEXT,
    "renderElapsedMs" INTEGER,
    "renderedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "short_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "short_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "short_clipCandidateId_fkey" FOREIGN KEY ("clipCandidateId") REFERENCES "clip_candidate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "short_clipCandidateId_key" ON "short"("clipCandidateId");

-- CreateIndex
CREATE INDEX "short_userId_updatedAt_idx" ON "short"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "short_videoId_idx" ON "short"("videoId");
