import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PackagingWorkspace } from "@/components/packaging/packaging-workspace";
import { PACKAGING_TARGET_KINDS, type PackagingTargetKind } from "@/lib/constants";
import { requireUser } from "@/server/session";
import { getAiSettings, getProviderStatuses } from "@/server/services/ai-providers";
import { getPackagingTarget, listPackagingSets, listThumbnails } from "@/server/services/packaging";

export const metadata: Metadata = { title: "Packaging" };

export default async function PackagingTargetPage({ params }: PageProps<"/packaging/[kind]/[id]">) {
  const user = await requireUser();
  const { kind, id } = await params;
  if (!PACKAGING_TARGET_KINDS.includes(kind as PackagingTargetKind)) notFound();
  // Filtered by owner: someone else's video or Short looks exactly like a missing one.
  const target = await getPackagingTarget(user.id, kind as PackagingTargetKind, id);
  if (!target) notFound();

  const [sets, thumbnails, settings, providers] = await Promise.all([
    listPackagingSets(user.id, target.kind, target.id),
    listThumbnails(user.id, target.kind, target.id),
    getAiSettings(user.id),
    getProviderStatuses(),
  ]);
  const provider = providers.find((p) => p.id === settings.llmProvider) ?? null;

  return (
    <PackagingWorkspace
      key={`${target.kind}:${target.id}`}
      target={target}
      initialSets={sets}
      initialThumbnails={thumbnails}
      provider={
        provider
          ? {
              label: provider.label,
              model: provider.model,
              local: provider.local,
              ready: provider.isAi && provider.ready,
              problem: provider.isAi ? provider.problem : "AI is turned off.",
              fix: provider.isAi
                ? provider.fix
                : "Packaging needs an AI model. Choose one in Settings › AI & processing.",
              privacy: provider.privacy,
            }
          : null
      }
      channelStyleSet={Boolean(settings.channelStyleNotes)}
    />
  );
}
