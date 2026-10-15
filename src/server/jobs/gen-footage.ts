import { z } from "zod";
import type { Job, Prisma } from "@/generated/prisma/client";
import { type StockCandidate, stockCandidatesSchema } from "@/lib/generator/stock";
import { db } from "../db";
import { generatorProjectIdOf } from "./gen-script";
import type { JobHandler } from "./handlers";

/** gen.footage — up to 5 stock candidates per scene; the best one is already downloaded (GEN-04). */
export const genFootageResultSchema = z.object({
  providers: z.array(z.enum(["pexels", "pixabay"])).max(2),
  scenes: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        candidates: stockCandidatesSchema,
        warnings: z.array(z.string().max(500)).max(5),
      }),
    )
    .max(40),
  failed: z.array(z.object({ id: z.string().min(1).max(100), error: z.string().max(500) })).max(40),
});
export type GenFootageResult = z.infer<typeof genFootageResultSchema>;

const payloadSchema = z.object({ scenes: z.array(z.object({ id: z.string() })) });

function sceneIdsOf(job: Job): string[] {
  return payloadSchema.parse(JSON.parse(job.payloadJson)).scenes.map((scene) => scene.id);
}

/** Records a stock clip in the shared cache table (one row per provider asset). */
export async function upsertStockAsset(tx: Prisma.TransactionClient, candidate: StockCandidate, downloaded: boolean) {
  const data = {
    pageUrl: candidate.pageUrl,
    creatorName: candidate.creatorName,
    creatorUrl: candidate.creatorUrl,
    downloadUrl: candidate.downloadUrl,
    previewImageUrl: candidate.previewImageUrl,
    filePath: `stock-cache/${candidate.provider}/${candidate.providerAssetId}.mp4`,
    width: candidate.width,
    height: candidate.height,
    durationMs: candidate.durationMs,
    licenseName: candidate.licenseName,
  };
  return tx.stockAsset.upsert({
    where: { provider_providerAssetId: { provider: candidate.provider, providerAssetId: candidate.providerAssetId } },
    create: {
      provider: candidate.provider,
      providerAssetId: candidate.providerAssetId,
      ...data,
      downloadedAt: downloaded ? new Date() : null,
    },
    update: downloaded ? { ...data, downloadedAt: new Date() } : data,
  });
}

export const genFootageHandler: JobHandler<GenFootageResult> = {
  resultSchema: genFootageResultSchema,

  async onSucceeded(tx, job, result) {
    const projectId = generatorProjectIdOf(job);
    if (!projectId) return;
    const requested = new Set(sceneIdsOf(job));
    for (const found of result.scenes) {
      if (!requested.has(found.id)) continue;
      const scene = await tx.generatorScene.findFirst({ where: { id: found.id, projectId } });
      if (!scene) continue;
      const data: Prisma.GeneratorSceneUpdateInput = { candidatesJson: JSON.stringify(found.candidates) };
      // A clip the creator picked from the library or uploaded meanwhile wins.
      if (scene.footageSource === null || scene.footageSource === "stock") {
        const best = found.candidates.find((candidate) => candidate.filePath !== null);
        if (best) {
          const asset = await upsertStockAsset(tx, best, true);
          Object.assign(data, {
            footageSource: "stock",
            stockAsset: { connect: { id: asset.id } },
            clipStartMs: 0,
            footageStatus: "ready",
            footageError: null,
          });
        } else {
          Object.assign(data, {
            footageStatus: "failed",
            footageError: found.warnings[0] ?? "The best clip couldn't be downloaded. Pick another one.",
          });
        }
      }
      await tx.generatorScene.update({ where: { id: scene.id }, data });
    }
    for (const failure of result.failed) {
      if (!requested.has(failure.id)) continue;
      await tx.generatorScene.updateMany({
        where: { id: failure.id, projectId, footageStatus: "searching", footageSource: null },
        data: { footageStatus: "failed", footageError: failure.error },
      });
      // Footage chosen earlier stays; the message explains why the new search found nothing.
      await tx.generatorScene.updateMany({
        where: { id: failure.id, projectId, footageStatus: "searching", footageSource: { not: null } },
        data: { footageStatus: "ready", footageError: failure.error },
      });
    }
  },

  async onFailed(job) {
    const projectId = generatorProjectIdOf(job);
    if (!projectId) return;
    const ids = sceneIdsOf(job);
    await db.generatorScene.updateMany({
      where: { projectId, id: { in: ids }, footageStatus: "searching" },
      data:
        job.status === "cancelled"
          ? { footageStatus: "none", footageError: null }
          : { footageStatus: "failed", footageError: job.error ?? "Finding footage failed." },
    });
    // Scenes that already had footage keep it.
    await db.generatorScene.updateMany({
      where: { projectId, id: { in: ids }, footageStatus: { in: ["none", "failed"] }, footageSource: { not: null } },
      data: { footageStatus: "ready", footageError: null },
    });
  },

  async cannotRetryReason(job) {
    const projectId = generatorProjectIdOf(job);
    if (!projectId) return "This job is no longer linked to a project.";
    const count = await db.generatorScene.count({ where: { projectId, id: { in: sceneIdsOf(job) } } });
    return count === 0 ? "Those scenes were deleted." : null;
  },

  async onRetry(tx, job) {
    const projectId = generatorProjectIdOf(job);
    if (!projectId) return;
    await tx.generatorScene.updateMany({
      where: { projectId, id: { in: sceneIdsOf(job) } },
      data: { footageStatus: "searching", footageError: null },
    });
  },
};
