"use client";

import { AlertTriangle, Image as ImageIcon, Plus, Star, Trash2 } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  deletePackagingSetAction,
  savePackagingAction,
  setPreferredPackagingAction,
} from "@/app/(app)/packaging/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  byteCount,
  charCount,
  DESCRIPTION_MAX_BYTES,
  HASHTAGS_MAX,
  HOOK_MAX_CHARS,
  normalizeHashtag,
  packagingText,
  TITLE_MAX_CHARS,
} from "@/lib/packaging/limits";
import { formatTimecode } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { PackagingSetView } from "@/server/services/packaging";
import { CopyButton } from "./copy-button";

type Draft = {
  titles: string[];
  description: string;
  hashtags: { tag: string; selected: boolean }[];
  hooks: string[];
  conceptHeadlines: string[];
  selectedTitle: number;
  selectedHook: number;
};

function draftOf(set: PackagingSetView): Draft {
  return {
    titles: set.titles.map((t) => t.text),
    description: set.description,
    hashtags: set.hashtags,
    hooks: set.hooks.map((h) => h.text),
    conceptHeadlines: set.concepts.map((c) => c.headline),
    selectedTitle: set.selectedTitle,
    selectedHook: set.selectedHook,
  };
}

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** One packaging version: pick, edit, copy and save (PKG-01, 02, 05). */
export function SetEditor({
  set,
  onChanged,
  onDeleted,
  onFrame,
  onMockup,
}: {
  set: PackagingSetView;
  onChanged: (set: PackagingSetView | null) => void;
  onDeleted: () => void;
  /** Show the suggested frame in the frame picker. */
  onFrame: (ms: number) => void;
  /** Make a mock-up for a concept (its headline on its suggested frame, or the picker's frame). */
  onMockup: (headline: string, frameMs: number | null) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(set));
  const [newTag, setNewTag] = useState("");
  const [pending, startTransition] = useTransition();
  const saved = useMemo(() => JSON.stringify(draftOf(set)), [set]);
  const dirty = JSON.stringify(draft) !== saved;
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const selectedTags = draft.hashtags.filter((h) => h.selected).map((h) => h.tag);
  const title = draft.titles[draft.selectedTitle] ?? draft.titles[0] ?? "";
  const descriptionBytes = byteCount(draft.description);

  async function save(): Promise<PackagingSetView | null> {
    const result = await savePackagingAction(set.id, draft);
    if (!result.ok) {
      toast.error(result.error);
      return null;
    }
    setDraft(draftOf(result.data));
    onChanged(result.data);
    return result.data;
  }

  function saveOnly() {
    startTransition(async () => {
      if (await save()) toast.success("Changes saved.");
    });
  }

  function usePackaging() {
    startTransition(async () => {
      const fresh = dirty ? await save() : set;
      if (!fresh) return;
      const result = await setPreferredPackagingAction(set.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      onChanged({ ...fresh, preferred: true });
      toast.success("Saved as your packaging for this video.");
    });
  }

  function addTag() {
    const tag = normalizeHashtag(newTag);
    if (!tag) {
      toast.error("Use letters and numbers, e.g. VideoEditing.");
      return;
    }
    if (draft.hashtags.some((h) => h.tag.toLowerCase() === tag.toLowerCase())) {
      toast.error("That hashtag is already in the list.");
      return;
    }
    update({ hashtags: [...draft.hashtags, { tag, selected: true }] });
    setNewTag("");
  }

  return (
    <div className="space-y-4" data-testid="packaging-set">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Written by {set.model ?? "AI"} · {dateFormat.format(new Date(set.createdAt))}
          {set.inputNotes ? ` · Notes: “${set.inputNotes}”` : ""}
        </p>
        {set.preferred ? (
          <Badge variant="outline" className="border-success text-success">
            <Star data-icon="inline-start" /> Your packaging
          </Badge>
        ) : null}
        {dirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <CopyButton
            text={packagingText(title, draft.description, selectedTags)}
            label="Copy title, description and hashtags"
            what="Title, description and hashtags"
          />
          <Button type="button" variant="outline" size="sm" onClick={saveOnly} disabled={!dirty || pending}>
            Save changes
          </Button>
          <Button type="button" size="sm" onClick={usePackaging} disabled={pending || (set.preferred && !dirty)}>
            {pending ? <Spinner data-icon="inline-start" /> : <Star data-icon="inline-start" />}
            {set.preferred ? "Save" : "Use this packaging"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Delete this version"
            onClick={() => {
              if (!window.confirm("Delete this version of the packaging?")) return;
              startTransition(async () => {
                const result = await deletePackagingSetAction(set.id);
                if (result.ok) onDeleted();
                else toast.error(result.error);
              });
            }}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {set.warnings.length > 0 ? (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Notes about this version</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {set.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Titles</CardTitle>
          <CardDescription>Pick one and edit it freely. YouTube allows up to 100 characters.</CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={String(draft.selectedTitle)}
            onValueChange={(value) => update({ selectedTitle: Number(value) })}
            aria-label="Titles"
            className="gap-3"
          >
            {draft.titles.map((text, index) => (
              <SuggestionRow
                key={index}
                kind="title"
                index={index}
                text={text}
                max={TITLE_MAX_CHARS}
                original={set.titles[index]}
                onChange={(value) => update({ titles: draft.titles.map((t, i) => (i === index ? value : t)) })}
              />
            ))}
          </RadioGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Description</CardTitle>
            <CardDescription>
              {set.chapters.length > 0
                ? "Chapter times at the end come from the transcript; edit the names if you like."
                : "Edit it to sound like you. YouTube allows 5,000 bytes."}
            </CardDescription>
          </div>
          <CopyButton text={draft.description} label="Copy description" what="Description" />
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Textarea
            value={draft.description}
            rows={9}
            onChange={(event) => update({ description: event.target.value })}
            aria-label="Description"
          />
          <p
            className={cn(
              "text-right text-xs tabular-nums",
              descriptionBytes > DESCRIPTION_MAX_BYTES ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {descriptionBytes.toLocaleString("en")} / {DESCRIPTION_MAX_BYTES.toLocaleString("en")} bytes
            {descriptionBytes > DESCRIPTION_MAX_BYTES ? " — it will be shortened when saved" : ""}
          </p>
          {draft.description === set.description
            ? set.descriptionFlags.map((flag) => (
                <p key={flag} className="text-xs text-warning">
                  {flag}
                </p>
              ))
            : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Hashtags</CardTitle>
            <CardDescription>
              Click to include or leave out ({selectedTags.length} of max {HASHTAGS_MAX} selected). Only hashtags
              related to what&apos;s said in the video are suggested.
            </CardDescription>
          </div>
          <CopyButton
            text={selectedTags.map((tag) => `#${tag}`).join(" ")}
            label="Copy selected hashtags"
            what="Hashtags"
          />
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Hashtags">
            {draft.hashtags.map((hashtag, index) => (
              <Button
                key={hashtag.tag}
                type="button"
                size="sm"
                variant={hashtag.selected ? "default" : "outline"}
                aria-pressed={hashtag.selected}
                onClick={() =>
                  update({
                    hashtags: draft.hashtags.map((h, i) => (i === index ? { ...h, selected: !h.selected } : h)),
                  })
                }
              >
                #{hashtag.tag}
              </Button>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              addTag();
            }}
          >
            <Input
              value={newTag}
              onChange={(event) => setNewTag(event.target.value)}
              placeholder="Add a hashtag"
              aria-label="New hashtag"
              className="max-w-60"
              maxLength={40}
            />
            <Button type="submit" variant="outline" size="sm" disabled={draft.hashtags.length >= 30}>
              <Plus data-icon="inline-start" />
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Opening hooks</CardTitle>
          <CardDescription>
            Different ways to open the video — say it in the first seconds or show it as text.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {draft.hooks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hooks in this version.</p>
          ) : (
            <RadioGroup
              value={String(draft.selectedHook)}
              onValueChange={(value) => update({ selectedHook: Number(value) })}
              aria-label="Hooks"
              className="gap-3"
            >
              {draft.hooks.map((text, index) => (
                <SuggestionRow
                  key={index}
                  kind="hook"
                  index={index}
                  text={text}
                  max={HOOK_MAX_CHARS}
                  original={set.hooks[index]}
                  onChange={(value) => update({ hooks: draft.hooks.map((h, i) => (i === index ? value : h)) })}
                />
              ))}
            </RadioGroup>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Thumbnail concepts</CardTitle>
          <CardDescription>
            Ideas written by the AI — text only, not images. Turn one into a mock-up from a real frame of your video.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {set.concepts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No thumbnail concepts in this version.</p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-3" aria-label="Thumbnail concepts">
              {set.concepts.map((concept, index) => (
                <li key={index} className="space-y-2 rounded-lg border p-3 text-sm">
                  <Label htmlFor={`concept-${index}`} className="text-xs text-muted-foreground">
                    Text on the thumbnail (up to 5 words)
                  </Label>
                  <Input
                    id={`concept-${index}`}
                    value={draft.conceptHeadlines[index] ?? ""}
                    onChange={(event) =>
                      update({
                        conceptHeadlines: draft.conceptHeadlines.map((h, i) => (i === index ? event.target.value : h)),
                      })
                    }
                  />
                  <p>
                    <span className="text-muted-foreground">Picture: </span>
                    {concept.composition}
                  </p>
                  {concept.emotion ? (
                    <p>
                      <span className="text-muted-foreground">Feeling: </span>
                      {concept.emotion}
                    </p>
                  ) : null}
                  {concept.flags.map((flag) => (
                    <p key={flag} className="text-xs text-warning">
                      {flag}
                    </p>
                  ))}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {concept.frameMs !== null ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => onFrame(concept.frameMs ?? 0)}>
                        Show frame at {formatTimecode(concept.frameMs)}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onMockup(draft.conceptHeadlines[index] ?? concept.headline, concept.frameMs)}
                    >
                      <ImageIcon data-icon="inline-start" />
                      Make mock-up
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SuggestionRow({
  kind,
  index,
  text,
  max,
  original,
  onChange,
}: {
  kind: "title" | "hook";
  index: number;
  text: string;
  max: number;
  original: { text: string; flags: string[]; edited: boolean } | undefined;
  onChange: (value: string) => void;
}) {
  const id = `${kind}-${index}`;
  const edited = original ? original.edited || original.text !== text : true;
  const flags = original && original.text === text ? original.flags : [];
  const label = kind === "title" ? "Title" : "Hook";
  return (
    <div className="flex items-start gap-3">
      <RadioGroupItem
        value={String(index)}
        id={`${id}-choose`}
        aria-label={`Choose ${label.toLowerCase()} ${index + 1}`}
        className="mt-2.5"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <Input
          id={id}
          value={text}
          maxLength={max}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${label} ${index + 1}`}
        />
        <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {charCount(text)} / {max}
          </span>
          <span>{edited ? "Edited by you" : "AI suggestion"}</span>
          {flags.map((flag) => (
            <span key={flag} className="text-warning">
              {flag}
            </span>
          ))}
        </div>
      </div>
      <CopyButton text={text} label={`Copy ${label.toLowerCase()} ${index + 1}`} what={label} size="icon-sm" />
    </div>
  );
}
