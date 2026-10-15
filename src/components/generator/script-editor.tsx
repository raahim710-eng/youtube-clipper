"use client";

import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { estimateMs, wordCount } from "@/lib/generator/timeline";
import type { ProjectView, ScriptDoc } from "@/server/services/generator";

type DraftScene = ScriptDoc["scenes"][number] & { key: string };

let nextKey = 0;
const newKey = () => `new-${++nextKey}`;

function docOf(project: ProjectView): { title: string; hook: string; scenes: DraftScene[] } {
  return {
    title: project.title ?? project.settings.topic,
    hook: project.hook ?? "",
    scenes: project.scenes.map((scene) => ({
      key: scene.id,
      id: scene.id,
      narration: scene.narration,
      visualQuery: scene.visualQuery,
      onScreenText: scene.onScreenText,
    })),
  };
}

/**
 * Script step (GEN-02): every scene's narration, footage keywords and optional on-screen text are editable;
 * scenes can be added, removed and reordered. The creator must approve the script before narration starts.
 */
export function ScriptEditor({
  project,
  busy,
  onSave,
  onApprove,
}: {
  project: ProjectView;
  busy: boolean;
  onSave: (doc: ScriptDoc) => Promise<boolean>;
  onApprove: (doc: ScriptDoc | null) => void;
}) {
  const [doc, setDoc] = useState(() => docOf(project));
  const [dirty, setDirty] = useState(false);
  const locked = project.status === "scripting" || project.status === "rendering";

  const change = (next: typeof doc) => {
    setDoc(next);
    setDirty(true);
  };
  const updateScene = (index: number, patch: Partial<DraftScene>) =>
    change({ ...doc, scenes: doc.scenes.map((scene, i) => (i === index ? { ...scene, ...patch } : scene)) });
  const move = (index: number, by: -1 | 1) => {
    const scenes = [...doc.scenes];
    const [scene] = scenes.splice(index, 1);
    scenes.splice(index + by, 0, scene);
    change({ ...doc, scenes });
  };
  const toSave = (): ScriptDoc => ({
    title: doc.title,
    hook: doc.hook || null,
    scenes: doc.scenes.map(({ id, narration, visualQuery, onScreenText }) => ({
      id,
      narration,
      visualQuery,
      onScreenText: onScreenText || null,
    })),
  });

  const words = doc.scenes.reduce((sum, scene) => sum + wordCount(scene.narration), 0);
  const target = Math.round((project.settings.targetDurationSec / 60) * 150);
  const offTarget = Math.abs(words - target) > target * 0.2;

  return (
    <div className="space-y-5" data-testid="script-editor">
      <Alert>
        <AlertTriangle />
        <AlertTitle>Check the facts before you continue</AlertTitle>
        <AlertDescription>
          The script was written by AI
          {project.script.model ? ` (${project.script.provider}, ${project.script.model})` : ""} and can contain
          mistakes or made-up details. Read every scene and correct anything you can&apos;t confirm.
        </AlertDescription>
      </Alert>
      {project.script.warnings.map((warning) => (
        <p key={warning} className="text-sm text-warning">
          {warning}
        </p>
      ))}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="script-title">Title</Label>
          <Input
            id="script-title"
            value={doc.title}
            maxLength={100}
            disabled={locked}
            onChange={(event) => change({ ...doc, title: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="script-hook">Hook (a one-line teaser; spoken only if scene 1 says it)</Label>
          <Input
            id="script-hook"
            value={doc.hook}
            maxLength={300}
            disabled={locked}
            onChange={(event) => change({ ...doc, hook: event.target.value })}
          />
        </div>
      </div>

      <p className={offTarget ? "text-sm text-warning" : "text-sm text-muted-foreground"} data-testid="script-length">
        {words} words ≈ {Math.round((words / 150) * 60)} seconds of narration (target: about {target} words for{" "}
        {project.settings.targetDurationSec} seconds).
      </p>

      <ol className="space-y-4" aria-label="Scenes">
        {doc.scenes.map((scene, index) => (
          <li key={scene.key} className="space-y-3 rounded-lg border p-4" data-testid="script-scene">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">Scene {index + 1}</p>
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {wordCount(scene.narration)} words · ~{Math.round(estimateMs(scene.narration) / 1000)} s
              </Badge>
              <div className="ml-auto flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move scene ${index + 1} up`}
                  disabled={locked || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move scene ${index + 1} down`}
                  disabled={locked || index === doc.scenes.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove scene ${index + 1}`}
                  disabled={locked || doc.scenes.length === 1}
                  onClick={() => change({ ...doc, scenes: doc.scenes.filter((_, i) => i !== index) })}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`narration-${scene.key}`}>Narration</Label>
              <Textarea
                id={`narration-${scene.key}`}
                value={scene.narration}
                maxLength={1500}
                rows={3}
                disabled={locked}
                onChange={(event) => updateScene(index, { narration: event.target.value })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`query-${scene.key}`}>Footage keywords</Label>
                <Input
                  id={`query-${scene.key}`}
                  value={scene.visualQuery}
                  maxLength={120}
                  disabled={locked}
                  onChange={(event) => updateScene(index, { visualQuery: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`onscreen-${scene.key}`}>On-screen text idea (optional, not rendered)</Label>
                <Input
                  id={`onscreen-${scene.key}`}
                  value={scene.onScreenText ?? ""}
                  maxLength={120}
                  disabled={locked}
                  onChange={(event) => updateScene(index, { onScreenText: event.target.value })}
                />
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked || doc.scenes.length >= 40}
              onClick={() => {
                const scenes = [...doc.scenes];
                scenes.splice(index + 1, 0, {
                  key: newKey(),
                  id: null,
                  narration: "",
                  visualQuery: "",
                  onScreenText: null,
                });
                change({ ...doc, scenes });
              }}
            >
              <Plus data-icon="inline-start" />
              Add a scene after this one
            </Button>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button
          type="button"
          variant="outline"
          disabled={busy || locked || !dirty}
          onClick={async () => {
            if (await onSave(toSave())) setDirty(false);
          }}
          data-testid="save-script"
        >
          {busy ? <Spinner data-icon="inline-start" /> : null}
          Save changes
        </Button>
        <Button
          type="button"
          disabled={busy || locked}
          onClick={() => onApprove(dirty ? toSave() : null)}
          data-testid="approve-script"
        >
          {project.script.approved ? "Save and update narration" : "I've checked it — approve the script"}
        </Button>
        <p className="text-xs text-muted-foreground">
          {project.script.approved
            ? "Approved. Edited scenes need new narration; it's recorded automatically when you click the button."
            : "Approving starts the narration and the footage search."}
        </p>
      </div>
    </div>
  );
}
