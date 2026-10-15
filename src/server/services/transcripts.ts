import "server-only";
import { db } from "../db";
import { AppError } from "../errors";
import { assertNoActiveJob } from "../jobs/queue";
import { queueTranscription } from "../jobs/queue-transcription";
import { readTranscriptFile } from "../transcripts/transcript-file";
import { getAiSettings } from "./ai-providers";

/** Transcripts (CLIP-01/02). Every query is scoped to the owner through the video. */

export type TranscriptSegmentView = {
  startMs: number;
  endMs: number;
  text: string;
};

export type TranscriptView = {
  status: "none" | "processing" | "ready" | "failed";
  provider: string | null;
  model: string | null;
  language: string | null;
  wordCount: number;
  errorMessage: string | null;
  segments: TranscriptSegmentView[];
  job: { id: string; status: string; progress: number; progressMessage: string | null } | null;
};

async function getOwnedVideo(userId: string, videoId: string) {
  const video = await db.video.findFirst({ where: { id: videoId, userId } });
  if (!video) throw new AppError("NOT_FOUND", "Video not found.");
  return video;
}

export async function getTranscriptView(userId: string, videoId: string): Promise<TranscriptView> {
  await getOwnedVideo(userId, videoId);
  const [transcript, job] = await Promise.all([
    db.transcript.findUnique({ where: { videoId } }),
    db.job.findFirst({
      where: { userId, entityType: "video", entityId: videoId, type: "media.transcribe" },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, progress: true, progressMessage: true },
    }),
  ]);
  if (!transcript) {
    return {
      status: "none",
      provider: null,
      model: null,
      language: null,
      wordCount: 0,
      errorMessage: null,
      segments: [],
      job,
    };
  }
  let segments: TranscriptSegmentView[] = [];
  if (transcript.status === "ready" && transcript.filePath) {
    const file = await readTranscriptFile(transcript.filePath);
    segments = file.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
  }
  return {
    status: transcript.status as TranscriptView["status"],
    provider: transcript.provider,
    model: transcript.model,
    language: transcript.language,
    wordCount: transcript.wordCount,
    errorMessage: transcript.errorMessage,
    segments,
    job,
  };
}

/** Starts (or restarts) transcription. Refused while one is already running. */
export async function startTranscription(userId: string, videoId: string): Promise<void> {
  const video = await getOwnedVideo(userId, videoId);
  if (video.status !== "ready") throw new AppError("VALIDATION", "Wait until the video has finished processing.");
  if (video.audioCodec === null) {
    throw new AppError("VALIDATION", "This video has no audio track, so there's nothing to transcribe.");
  }
  const active = await db.job.count({
    where: { entityType: "video", entityId: videoId, type: "media.transcribe", status: { in: ["queued", "running"] } },
  });
  if (active > 0) throw new AppError("CONFLICT", "This video is already being transcribed.");
  const { defaultLanguage } = await getAiSettings(userId);
  await db.$transaction(async (tx) => {
    await assertNoActiveJob(
      tx,
      { entityType: "video", entityId: videoId, type: "media.transcribe" },
      "This video is already being transcribed.",
    );
    await queueTranscription(tx, userId, videoId, defaultLanguage);
  });
}
