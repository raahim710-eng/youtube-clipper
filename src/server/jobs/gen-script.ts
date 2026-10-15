import { z } from "zod";
import type { Job } from "@/generated/prisma/client";
import { db } from "../db";
import type { JobHandler } from "./handlers";

/** gen.script — title, hook and scenes for a generated video (GEN-02, TECHNICAL_SPEC.md §7.7). */
export const genScriptResultSchema = z.object({
  provider: z.string().min(1).max(50),
  model: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  hook: z.string().max(300),
  scenes: z
    .array(
      z.object({
        narration: z.string().trim().min(1).max(1500),
        visualQuery: z.string().trim().min(1).max(120),
        onScreenText: z.string().max(120).nullable().optional(),
        estimatedMs: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(40),
  wordCount: z.number().int().nonnegative(),
  targetWords: z.number().int().positive(),
  warnings: z.array(z.string().max(400)).max(10),
});
export type GenScriptResult = z.infer<typeof genScriptResultSchema>;

export function generatorProjectIdOf(job: Job): string | null {
  return job.entityType === "generator" && job.entityId ? job.entityId : null;
}

export const genScriptHandler: JobHandler<GenScriptResult> = {
  resultSchema: genScriptResultSchema,

  async onSucceeded(tx, job, result) {
    const projectId = generatorProjectIdOf(job);
    if (!projectId) return;
    const project = await tx.generatorProject.findUnique({ where: { id: projectId }, select: { status: true } });
    if (project?.status !== "scripting") return; // deleted or changed meanwhile
    await tx.generatorScene.deleteMany({ where: { projectId } });
    await tx.generatorScene.createMany({
      data: result.scenes.map((scene, order) => ({
        projectId,
        order,
        narration: scene.narration,
        visualQuery: scene.visualQuery,
        onScreenText: scene.onScreenText?.trim() || null,
        estimatedMs: scene.estimatedMs,
      })),
    });
    await tx.generatorProject.update({
      where: { id: projectId },
      data: {
        status: "editing",
        error: null,
        title: result.title.slice(0, 100),
        hook: result.hook || null,
        scriptProvider: result.provider,
        scriptModel: result.model,
        scriptWarningsJson: JSON.stringify(result.warnings),
        scriptApprovedAt: null,
      },
    });
  },

  async onFailed(job) {
    const projectId = generatorProjectIdOf(job);
    if (!projectId) return;
    const project = await db.generatorProject.findUnique({
      where: { id: projectId },
      select: { status: true, _count: { select: { scenes: true } } },
    });
    if (project?.status !== "scripting") return;
    await db.generatorProject.update({
      where: { id: projectId },
      data: {
        status: project._count.scenes > 0 ? "editing" : "draft",
        error: job.status === "cancelled" ? null : (job.error ?? "Writing the script failed."),
      },
    });
  },

  async cannotRetryReason(job) {
    const projectId = generatorProjectIdOf(job);
    if (!projectId) return "This job is no longer linked to a project.";
    const project = await db.generatorProject.findUnique({ where: { id: projectId }, select: { status: true } });
    if (!project) return "The project was deleted.";
    if (project.status === "rendering") return "The video is being rendered.";
    return null;
  },

  async onRetry(tx, job) {
    const projectId = generatorProjectIdOf(job);
    if (projectId)
      await tx.generatorProject.update({ where: { id: projectId }, data: { status: "scripting", error: null } });
  },
};
