import type { Prisma } from "@/generated/prisma/client";
import { getEnv } from "../env";
import { transcriptPathFor } from "./media-transcribe";
import { enqueueJob } from "./queue";

/**
 * Creates (or resets) the video's transcript record and queues `media.transcribe`.
 * Used after ingest (auto-transcribe) and when the owner asks for a (re-)transcription.
 */
export async function queueTranscription(
  tx: Prisma.TransactionClient,
  userId: string,
  videoId: string,
  language: string,
): Promise<void> {
  const video = await tx.video.findUniqueOrThrow({ where: { id: videoId }, select: { sourcePath: true } });
  const env = getEnv();
  await tx.transcript.upsert({
    where: { videoId },
    create: { videoId, status: "processing", provider: env.TRANSCRIPTION_PROVIDER, model: env.WHISPER_MODEL },
    update: {
      status: "processing",
      provider: env.TRANSCRIPTION_PROVIDER,
      model: env.WHISPER_MODEL,
      errorMessage: null,
    },
  });
  await enqueueJob(
    {
      userId,
      type: "media.transcribe",
      entityType: "video",
      entityId: videoId,
      payload: { videoId, sourcePath: video.sourcePath, outputPath: transcriptPathFor(videoId), language },
      // Transcription is slow on CPUs; let quick jobs (new uploads) go first.
      priority: 200,
    },
    tx,
  );
}
