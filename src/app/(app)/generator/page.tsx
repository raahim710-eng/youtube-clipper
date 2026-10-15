import { WandSparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { NewProjectForm } from "@/components/generator/new-project-form";
import { ProjectStatusBadge } from "@/components/generator/project-status-badge";
import { ProviderInfo } from "@/components/generator/provider-info";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { findNavItem } from "@/lib/navigation";
import { requireUser } from "@/server/session";
import { getAiSettings, getProviderStatuses } from "@/server/services/ai-providers";
import { getGeneratorSetup, listProjects } from "@/server/services/generator";

const item = findNavItem("/generator");

export const metadata: Metadata = { title: item.title };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** Original Video Generator home: start a video from a topic, and the projects so far (GEN-01). */
export default async function GeneratorPage() {
  const user = await requireUser();
  const [projects, setup, aiSettings, providers] = await Promise.all([
    listProjects(user.id),
    getGeneratorSetup(),
    getAiSettings(user.id),
    getProviderStatuses(),
  ]);
  const ai = providers.find((provider) => provider.id === aiSettings.llmProvider) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader title={item.title} description={item.description} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New video</CardTitle>
            <CardDescription>
              Describe the video. The AI writes a script you can edit; nothing is narrated or rendered until you approve
              it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <NewProjectForm voices={setup.tts.voices} />
          </CardContent>
        </Card>
        <ProviderInfo setup={setup} ai={ai} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your projects ({projects.length})</CardTitle>
          <CardDescription>Finished videos also appear in Videos, marked “Generated”.</CardDescription>
        </CardHeader>
        <CardContent>
          {projects.length === 0 ? (
            <p className="flex items-center justify-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              <WandSparkles className="size-4" aria-hidden /> No projects yet. Start one above.
            </p>
          ) : (
            <ul className="divide-y" aria-label="Generator projects">
              {projects.map((project) => (
                <li key={project.id}>
                  <Link
                    href={`/generator/${project.id}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{project.title ?? project.topic}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {project.aspectRatio === "9:16" ? "Vertical" : "Landscape"} · {project.targetDurationSec} s ·{" "}
                        {project.sceneCount} scene{project.sceneCount === 1 ? "" : "s"} · updated{" "}
                        {dateFormat.format(new Date(project.updatedAt))}
                      </span>
                    </span>
                    <ProjectStatusBadge status={project.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
