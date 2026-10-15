import { z } from "zod";
import type { Job } from "@/generated/prisma/client";
import { wordTimingsSchema } from "@/lib/generator/timeline";
import { db } from "../db";
import { generatorProjectIdOf } from "./gen-script";
import type { JobHandler } from "./handlers";

/** gen.narrate — one WAV per scene with word timings (GEN-03). Scenes succeed or fail independently. */
export const genNarrateResultSchema = z.object({
  provider: z.string().min(1).max(50),
  voice: z.string().max(100).nullable(),
  scenes: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        audioPath: z.string().min(1).max(300),
        durationMs: z.number().int().positive().max(600_000),
        words: wordTimingsSchema,
        timing: z.enum(["engine", "estimated"]),
      }),
    )
    .max(40),
  failed: z.array(z.object({ id: z.string().min(1).max(100), error: z.string().max(500) })).max(40),
});
export type GenNarrateResult = z.infer<typeof genNarrateResultSchema>;

export const genNarratePayloadSchema = z.object({
  projectId: z.string(),
  scenes: z.array(z.object({ id: z.string(), text: z.string(), outputPath: z.string() })),
});

function payloadOf(job: Job) {
  return genNarratePayloadSchema.parse(JSON.parse(job.payloadJson));
}

export const genNarrateHandler: JobHandler<GenNarrateResult> = {
  resultSchema: genNarrateResultSchema,

  async onSucceeded(tx, job, result) {
    const projectId = generatorProjectIdOf(job);
    if (!projectId) return;
    const requested = new Map(payloadOf(job).scenes.map((scene) => [scene.id, scene]));
    for (const scene of result.scenes) {
      // The worker may only report the files the app asked for.
      const asked = requested.get(scene.id);
      if (!asked || asked.outputPath !== scene.audioPath) throw new Error("Unexpected narration result");
      await tx.generatorScene.updateMany({
        where: { id: scene.id, projectId },
        data: {
          narrationStatus: "ready",
          narrationError: null,
          audioPath: scene.audioPath,
          audioDurationMs: scene.durationMs,
          wordTimingsJson: JSON.stringify(scene.words),
          timingSource: scene.timing,
          narratedText: asked.text,
        },
      });
    }
    for (const failure of result.failed) {
      if (!requested.has(failure.id)) continue;
      await tx.generatorScene.updateMany({
        where: { id: failure.id, projectId },
        data: { narrationStatus: "failed", narrationError: failure.error },
      });
    }
  },

  async onFailed(job) {
    const projectId = generatorProjectIdOf(job);
    if (!projectId) return;
    const ids = payloadOf(job).scenes.map((scene) => scene.id);
    const cancelled = job.status === "cancelled";
    await db.generatorScene.updateMany({
      where: { projectId, id: { in: ids }, narrationStatus: "processing" },
      data: cancelled
        ? { narrationStatus: "none", narrationError: null }
        : { narrationStatus: "failed", narrationError: job.error ?? "Recording the narration failed." },
    });
    // Scenes that already had audio keep it.
    await db.generatorScene.updateMany({
      where: { projectId, id: { in: ids }, narrationStatus: "none", audioPath: { not: null } },
      data: { narrationStatus: "ready" },
    });
  },

  async cannotRetryReason(job) {
    const projectId = generatorProjectIdOf(job);
    if (!projectId) return "This job is no longer linked to a project.";
    const count = await db.generatorScene.count({
      where: { projectId, id: { in: payloadOf(job).scenes.map((scene) => scene.id) } },
    });
    return count === 0 ? "Those scenes were deleted." : null;
  },

  async onRetry(tx, job) {
    const projectId = generatorProjectIdOf(job);
    if (!projectId) return;
    await tx.generatorScene.updateMany({
      where: { projectId, id: { in: payloadOf(job).scenes.map((scene) => scene.id) } },
      data: { narrationStatus: "processing", narrationError: null },
    });
  },
};
