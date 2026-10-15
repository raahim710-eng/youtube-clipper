-- CreateTable
CREATE TABLE "transcript" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "language" TEXT,
    "languageProbability" REAL,
    "filePath" TEXT,
    "fullText" TEXT,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "segmentCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "transcript_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "clip_candidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "transcriptText" TEXT NOT NULL,
    "score" INTEGER,
    "heuristicScore" INTEGER,
    "aiScore" INTEGER,
    "title" TEXT NOT NULL,
    "hook" TEXT,
    "reason" TEXT,
    "category" TEXT,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "provider" TEXT,
    "model" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "clip_candidate_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_user_settings" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "defaultLanguage" TEXT NOT NULL DEFAULT 'auto',
    "autoTranscribe" BOOLEAN NOT NULL DEFAULT true,
    "llmProvider" TEXT NOT NULL DEFAULT 'ollama',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "user_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_user_settings" ("createdAt", "defaultLanguage", "updatedAt", "userId") SELECT "createdAt", "defaultLanguage", "updatedAt", "userId" FROM "user_settings";
DROP TABLE "user_settings";
ALTER TABLE "new_user_settings" RENAME TO "user_settings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "transcript_videoId_key" ON "transcript"("videoId");

-- CreateIndex
CREATE INDEX "clip_candidate_videoId_score_idx" ON "clip_candidate"("videoId", "score");

-- CreateIndex
CREATE INDEX "clip_candidate_videoId_status_idx" ON "clip_candidate"("videoId", "status");
