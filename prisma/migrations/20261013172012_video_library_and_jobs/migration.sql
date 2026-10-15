-- CreateTable
CREATE TABLE "upload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "totalBytes" BIGINT NOT NULL,
    "chunkSize" INTEGER NOT NULL,
    "totalChunks" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "error" TEXT,
    "videoId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "upload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "upload_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "video" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'upload',
    "status" TEXT NOT NULL DEFAULT 'processing',
    "errorMessage" TEXT,
    "originalFilename" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "previewPath" TEXT,
    "posterPath" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "durationMs" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "fps" REAL,
    "videoCodec" TEXT,
    "audioCodec" TEXT,
    "container" TEXT NOT NULL,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "video_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "payloadJson" TEXT NOT NULL,
    "resultJson" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "progressMessage" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAfter" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "leaseExpiresAt" DATETIME,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "errorCode" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "worker_heartbeat" (
    "workerId" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "capabilitiesJson" TEXT NOT NULL DEFAULT '{}',
    "lastSeenAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "upload_videoId_key" ON "upload"("videoId");

-- CreateIndex
CREATE INDEX "upload_userId_status_idx" ON "upload"("userId", "status");

-- CreateIndex
CREATE INDEX "upload_status_expiresAt_idx" ON "upload"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "video_userId_createdAt_idx" ON "video"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "video_userId_status_idx" ON "video"("userId", "status");

-- CreateIndex
CREATE INDEX "job_status_type_priority_createdAt_idx" ON "job"("status", "type", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "job_entityType_entityId_idx" ON "job"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "job_userId_createdAt_idx" ON "job"("userId", "createdAt");
