"use client";

import { AlertCircle, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  approveScriptAction,
  cancelGeneratorJobAction,
  chooseLibraryAction,
  chooseStockAction,
  deleteProjectAction,
  findFootageAction,
  getProjectAction,
  narrateAction,
  removeMusicAction,
  renderAction,
  saveScriptAction,
  setClipStartAction,
  updateSettingsAction,
  writeScriptAction,
} from "@/app/(app)/generator/actions";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ActionResult } from "@/server/errors";
import type { GeneratorSetup, ProjectView } from "@/server/services/generator";
import { JOB_TYPE_LABELS } from "@/lib/constants";
import { BriefForm } from "./brief-form";
import { ProjectStatusBadge } from "./project-status-badge";
import { RenderPanel } from "./render-panel";
import { type LibraryVideo, SceneCard } from "./scene-card";
import { ScriptEditor } from "./script-editor";

type Step = "brief" | "script" | "scenes" | "render";

function stepFor(project: ProjectView): Step {
  if (project.scenes.length === 0) return "brief";
  if (!project.script.approved) return "script";
  if (project.status === "rendering" || project.status === "ready") return "render";
  return "scenes";
}

async function upload(url: string, file: File): Promise<string | null> {
  const extension = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
  try {
    const response = await fetch(`${url}?ext=${encodeURIComponent(extension)}`, { method: "POST", body: file });
    if (response.ok) return null;
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? `Upload failed (HTTP ${response.status}).`;
  } catch {
    return "Upload failed. Check the connection and try again.";
  }
}

/**
 * The generator workspace (UI_UX.md §5.6): Brief → Script → Scenes → Render. Long-running steps run in
 * the media worker; this page polls every 2 seconds while any of them is active and shows real progress.
 */
export function GeneratorWorkspace({
  initial,
  setup,
  library,
}: {
  initial: ProjectView;
  setup: GeneratorSetup;
  library: LibraryVideo[];
}) {
  const [project, setProject] = useState(initial);
  const [step, setStep] = useState<Step>(() => stepFor(initial));
  const [pending, startTransition] = useTransition();
  const [deleting, startDelete] = useTransition();
  const previous = useRef(initial);
  const stockAvailable = setup.stock.pexels || setup.stock.pixabay;
  const active = project.jobs.length > 0 || project.status === "scripting" || project.status === "rendering";
  const locked = project.status === "scripting" || project.status === "rendering";

  /** Takes fresh project data, tells the creator when something finished and moves to the next step. */
  const receive = useCallback((project: ProjectView) => {
    const before = previous.current;
    previous.current = project;
    setProject(project);
    if (before.status === "scripting" && project.status !== "scripting") {
      if (project.scenes.length > 0 && !project.error) {
        toast.success("The script is ready. Review it before continuing.");
        setStep("script");
      } else if (project.error) toast.error("Writing the script failed.");
    }
    if (before.status === "rendering" && project.status !== "rendering") {
      if (project.status === "ready" && !project.error) toast.success("Your video is ready and in the library.");
      else if (project.error) toast.error("Rendering failed. See the message above.");
    }
    const wasNarrating = before.jobs.some((job) => job.type === "gen.narrate");
    if (wasNarrating && !project.jobs.some((job) => job.type === "gen.narrate")) {
      const failed = project.scenes.filter((scene) => scene.narration_.status === "failed").length;
      if (failed > 0) toast.error(`${failed} scene${failed === 1 ? "" : "s"} couldn't be narrated.`);
      else toast.success("Narration recorded.");
    }
  }, []);

  // ---- Polling while the worker is busy ----
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      const result = await getProjectAction(initial.id);
      if (result.ok) receive(result.data);
    }, 2000);
    return () => clearInterval(timer);
  }, [active, initial.id, receive]);

  function run<T>(action: () => Promise<ActionResult<T>>, onDone?: (data: T) => void) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      onDone?.(result.data);
    });
  }
  const apply = receive;
  const refresh = () => run(() => getProjectAction(project.id), apply);

  const counts = {
    narrated: project.scenes.filter((s) => s.narration_.status === "ready" && !s.narration_.stale).length,
    footage: project.scenes.filter((s) => s.footage.source !== null).length,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={project.title ?? project.settings.topic}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <ProjectStatusBadge status={project.status} />
            <span>Topic: {project.settings.topic}</span>
          </span>
        }
        actions={
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="ghost" size="sm">
                <Trash2 data-icon="inline-start" />
                Delete project
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this project?</AlertDialogTitle>
                <AlertDialogDescription>
                  The script, narration, uploaded clips and music of “{project.title ?? project.settings.topic}” are
                  deleted. Videos you already rendered stay in your library.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={deleting}
                  onClick={(event) => {
                    event.preventDefault();
                    startDelete(async () => {
                      const result = await deleteProjectAction(project.id);
                      if (result && !result.ok) toast.error(result.error);
                    });
                  }}
                >
                  Delete project
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        }
      />

      {project.error ? (
        <Alert variant="destructive" data-testid="project-error">
          <AlertCircle />
          <AlertTitle>Something needs your attention</AlertTitle>
          <AlertDescription>{project.error}</AlertDescription>
        </Alert>
      ) : null}

      {project.jobs.length > 0 ? (
        <ul className="space-y-2" aria-label="Work in progress">
          {project.jobs.map((job) => (
            <li key={job.id} className="space-y-2 rounded-lg border p-3" role="status" data-testid="generator-job">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {job.status === "queued"
                    ? `${JOB_TYPE_LABELS[job.type]} — waiting for the media worker…`
                    : `${JOB_TYPE_LABELS[job.type]}…`}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => run(() => cancelGeneratorJobAction(project.id, job.id), apply)}
                >
                  <X data-icon="inline-start" />
                  Cancel
                </Button>
              </div>
              <Progress value={job.progress} aria-label={`${JOB_TYPE_LABELS[job.type]} progress`} />
              <p className="text-xs text-muted-foreground">
                {job.progress}% {job.message ? `· ${job.message}` : ""}
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      <Tabs value={step} onValueChange={(value) => setStep(value as Step)}>
        <TabsList aria-label="Steps">
          <TabsTrigger value="brief">1. Brief</TabsTrigger>
          <TabsTrigger value="script" disabled={project.scenes.length === 0}>
            2. Script
          </TabsTrigger>
          <TabsTrigger value="scenes" disabled={!project.script.approved}>
            3. Voice &amp; footage
          </TabsTrigger>
          <TabsTrigger value="render" disabled={!project.script.approved}>
            4. Render
          </TabsTrigger>
        </TabsList>

        <TabsContent value="brief" className="space-y-4 pt-4">
          {project.status === "scripting" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="scripting">
              <Spinner /> The AI is writing the script. A local model can take a few minutes on this computer.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={pending || locked}
                onClick={() => run(() => writeScriptAction(project.id), apply)}
                data-testid="write-script"
              >
                {project.scenes.length > 0 ? "Write a new script" : "Write the script"}
              </Button>
              {project.scenes.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  A new script replaces the scenes, their narration and their footage.
                </p>
              ) : null}
            </div>
          )}
          <BriefForm
            initial={project.settings}
            voices={setup.tts.voices}
            submitLabel="Save settings"
            busy={pending}
            disabled={locked}
            onSubmit={(settings) =>
              run(
                () => updateSettingsAction(project.id, settings),
                (next) => {
                  apply(next);
                  toast.success("Settings saved.");
                },
              )
            }
          />
        </TabsContent>

        <TabsContent value="script" className="pt-4">
          {project.scenes.length > 0 ? (
            <ScriptEditor
              key={project.scenes.map((scene) => scene.id).join(",")}
              project={project}
              busy={pending}
              onSave={async (doc) => {
                const result = await saveScriptAction(project.id, doc);
                if (!result.ok) {
                  toast.error(result.error);
                  return false;
                }
                apply(result.data);
                toast.success("Script saved.");
                return true;
              }}
              onApprove={(doc) =>
                startTransition(async () => {
                  if (doc) {
                    const saved = await saveScriptAction(project.id, doc);
                    if (!saved.ok) {
                      toast.error(saved.error);
                      return;
                    }
                  }
                  const result = await approveScriptAction(project.id);
                  if (!result.ok) {
                    toast.error(result.error);
                    return;
                  }
                  apply(result.data.project);
                  for (const note of result.data.notes) toast.info(note, { duration: 10_000 });
                  setStep("scenes");
                })
              }
            />
          ) : null}
        </TabsContent>

        <TabsContent value="scenes" className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground" data-testid="scene-counts">
              {counts.narrated} of {project.scenes.length} narrated · {counts.footage} of {project.scenes.length} with
              footage
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || locked || counts.narrated === project.scenes.length}
              onClick={() => run(() => narrateAction(project.id, null), apply)}
            >
              Record missing narration
            </Button>
            {stockAvailable ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending || locked || counts.footage === project.scenes.length}
                onClick={() => run(() => findFootageAction(project.id, null), apply)}
              >
                Find footage for the rest
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={refresh}>
              Refresh
            </Button>
          </div>
          {!stockAvailable ? (
            <Alert data-testid="stock-guidance">
              <AlertCircle />
              <AlertTitle>No stock video provider is set up</AlertTitle>
              <AlertDescription>
                Choose a library video or upload a clip for each scene. For automatic stock footage, get a free key at
                pexels.com/api, add PEXELS_API_KEY to .env and restart the app.
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-xs text-muted-foreground">
              Stock videos provided by{" "}
              <a href="https://www.pexels.com" target="_blank" rel="noreferrer" className="underline">
                Pexels
              </a>
              {setup.stock.pixabay ? (
                <>
                  {" and "}
                  <a href="https://pixabay.com" target="_blank" rel="noreferrer" className="underline">
                    Pixabay
                  </a>
                </>
              ) : null}
              .
            </p>
          )}
          <ol className="space-y-4" aria-label="Scenes">
            {project.scenes.map((scene, index) => (
              <SceneCard
                key={`${scene.id}-${scene.footage.startMs}`}
                scene={scene}
                number={index + 1}
                library={library}
                stockAvailable={stockAvailable}
                locked={locked}
                busy={pending}
                onNarrate={() => run(() => narrateAction(project.id, [scene.id]), apply)}
                onSearch={() => run(() => findFootageAction(project.id, [scene.id]), apply)}
                onChooseStock={(assetId) => run(() => chooseStockAction(project.id, scene.id, assetId), apply)}
                onChooseLibrary={(videoId, startMs) =>
                  run(() => chooseLibraryAction(project.id, scene.id, { videoId, startMs }), apply)
                }
                onStartChange={(startMs) => run(() => setClipStartAction(project.id, scene.id, startMs), apply)}
                onUpload={(file) =>
                  startTransition(async () => {
                    const error = await upload(`/api/generator/scenes/${scene.id}/footage`, file);
                    if (error) toast.error(error);
                    else toast.success(`Clip added to scene ${index + 1}.`);
                    const result = await getProjectAction(project.id);
                    if (result.ok) apply(result.data);
                  })
                }
              />
            ))}
          </ol>
          <div className="flex justify-end">
            <Button type="button" onClick={() => setStep("render")} disabled={!project.script.approved}>
              Continue to render
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="render" className="pt-4">
          <RenderPanel
            project={project}
            busy={pending}
            onRender={() => run(() => renderAction(project.id), apply)}
            onUploadMusic={(file) =>
              startTransition(async () => {
                const error = await upload(`/api/generator/projects/${project.id}/music`, file);
                if (error) toast.error(error);
                else toast.success("Music added.");
                const result = await getProjectAction(project.id);
                if (result.ok) apply(result.data);
              })
            }
            onRemoveMusic={() => run(() => removeMusicAction(project.id), apply)}
            onMusicVolume={(volumeDb) =>
              run(() => updateSettingsAction(project.id, { ...project.settings, musicVolumeDb: volumeDb }), apply)
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
