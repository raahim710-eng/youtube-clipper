import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GeneratorWorkspace } from "@/components/generator/workspace";
import { requireUser } from "@/server/session";
import { getGeneratorSetup, getProject, listLibraryFootage } from "@/server/services/generator";

export const metadata: Metadata = { title: "Generate video" };

export default async function GeneratorProjectPage({ params }: PageProps<"/generator/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  // Filtered by owner: someone else's project looks exactly like a missing one.
  const [project, setup, library] = await Promise.all([
    getProject(user.id, id),
    getGeneratorSetup(),
    listLibraryFootage(user.id),
  ]);
  if (!project) notFound();
  return <GeneratorWorkspace key={project.id} initial={project} setup={setup} library={library} />;
}
