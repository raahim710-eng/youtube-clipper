"use client";

import { AlertCircle, ArrowLeft, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { publishAction } from "@/app/(app)/youtube/actions";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { PRIVACY_LABELS, PRIVACY_STATUSES, type PrivacyStatus, YOUTUBE_CATEGORIES } from "@/lib/constants";
import { byteCount, charCount, DESCRIPTION_MAX_BYTES, TITLE_MAX_CHARS } from "@/lib/packaging/limits";
import { formatTimecode } from "@/lib/time";
import { cleanTags, type PublishInput, publishProblems, TAGS_MAX_CHARS, tagsLength } from "@/lib/youtube/publish";
import { cn } from "@/lib/utils";
import type { PublishForm as PublishFormData } from "@/server/services/youtube";

function yesNo(value: boolean | null): string {
  return value === null ? "" : value ? "yes" : "no";
}

/** Review metadata and upload to a connected channel (YT-04…08). */
export function PublishForm({ form }: { form: PublishFormData }) {
  const router = useRouter();
  const { target, setup, channels, prefill, thumbnails, quota } = form;
  const [channelId, setChannelId] = useState(
    channels.find((c) => c.id === form.defaultChannelId)?.id ?? channels[0]?.id ?? "",
  );
  const [title, setTitle] = useState(prefill.title);
  const [description, setDescription] = useState(prefill.description);
  const [tagsText, setTagsText] = useState(prefill.tags.join(", "));
  const [categoryId, setCategoryId] = useState("22");
  const [privacy, setPrivacy] = useState<PrivacyStatus>("private");
  const [schedule, setSchedule] = useState(false);
  const [publishLocal, setPublishLocal] = useState("");
  const [madeForKids, setMadeForKids] = useState<boolean | null>(null);
  const [synthetic, setSynthetic] = useState<boolean | null>(prefill.containsSyntheticMedia);
  const [thumbnailId, setThumbnailId] = useState<string | null>(thumbnails.find((t) => t.selected)?.id ?? null);
  const [pending, startTransition] = useTransition();

  const tags = cleanTags(tagsText.split(","));
  const publishAt = schedule && publishLocal ? new Date(publishLocal).toISOString() : null;
  const input: PublishInput = {
    kind: target.kind,
    targetId: target.id,
    channelId,
    title,
    description,
    tags,
    categoryId,
    privacyStatus: schedule ? "private" : privacy,
    publishAt,
    madeForKids,
    containsSyntheticMedia: synthetic,
    thumbnailId,
  };
  const problems = publishProblems(input, target, { audited: setup.audited });
  const uploadsLeft = quota.uploads.limit - quota.uploads.used;
  const resetLocal = new Date(quota.resetsAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const blocked = !setup.configured || channels.length === 0 || uploadsLeft <= 0;

  function submit() {
    startTransition(async () => {
      const result = await publishAction(input);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Upload started.");
      router.push(`/youtube?publication=${result.data.publicationId}`);
    });
  }

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href={target.editHref}>
          <ArrowLeft data-icon="inline-start" />
          Back
        </Link>
      </Button>
      <PageHeader
        title="Publish to YouTube"
        description={`${target.kind === "short" ? "Short" : "Video"}: ${target.title}${target.durationMs ? ` · ${formatTimecode(target.durationMs)}` : ""}`}
      />

      {!setup.configured ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>YouTube isn&apos;t set up yet</AlertTitle>
          <AlertDescription>
            {setup.problems.join(" ")} See README › Google Cloud setup, then{" "}
            <Link href="/settings/channels" className="underline underline-offset-2">
              connect a channel
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : channels.length === 0 ? (
        <Alert>
          <AlertCircle />
          <AlertTitle>No channel connected</AlertTitle>
          <AlertDescription>
            <Link href="/settings/channels" className="underline underline-offset-2">
              Connect a YouTube channel
            </Link>{" "}
            first. Channels that need reconnecting don&apos;t appear here.
          </AlertDescription>
        </Alert>
      ) : null}
      {uploadsLeft <= 0 ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Today&apos;s upload limit is used up</AlertTitle>
          <AlertDescription>
            {quota.uploads.limit} uploads per day (Google&apos;s limit for this project). It resets at midnight Pacific
            time — {resetLocal} your time.
          </AlertDescription>
        </Alert>
      ) : null}
      {target.sourceExportStale ? (
        <Alert>
          <AlertCircle />
          <AlertTitle>The exported Short is out of date</AlertTitle>
          <AlertDescription>
            You changed the Short after exporting it. The last exported file will be uploaded —{" "}
            <Link href={target.editHref} className="underline underline-offset-2">
              export it again
            </Link>{" "}
            first if you want your changes.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
          <CardDescription>
            {prefill.fromPackaging ? (
              <>
                Filled in from your chosen packaging.{" "}
                <Link href={target.packagingHref} className="underline underline-offset-2">
                  Change it there
                </Link>{" "}
                or edit below.
              </>
            ) : (
              <>
                No packaging chosen yet —{" "}
                <Link href={target.packagingHref} className="underline underline-offset-2">
                  write titles and a description with AI
                </Link>{" "}
                or type your own.
              </>
            )}
            {prefill.creditsAdded ? (
              <span className="mt-1 block" data-testid="credits-added-note">
                Stock footage and narration credits were added to the end of the description.
              </span>
            ) : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="publish-channel">Channel</Label>
            <Select value={channelId} onValueChange={setChannelId} disabled={channels.length === 0}>
              <SelectTrigger id="publish-channel" className="w-full max-w-md">
                <SelectValue placeholder="No channel connected" />
              </SelectTrigger>
              <SelectContent>
                {channels.map((channel) => (
                  <SelectItem key={channel.id} value={channel.id}>
                    {channel.title}
                    {channel.handle ? ` (${channel.handle})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="publish-title">Title</Label>
            <Input
              id="publish-title"
              value={title}
              maxLength={TITLE_MAX_CHARS}
              onChange={(e) => setTitle(e.target.value)}
            />
            <p className="text-right text-xs text-muted-foreground tabular-nums">
              {charCount(title)} / {TITLE_MAX_CHARS}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="publish-description">Description</Label>
            <Textarea
              id="publish-description"
              rows={8}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <p
              className={cn(
                "text-right text-xs tabular-nums",
                byteCount(description) > DESCRIPTION_MAX_BYTES ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {byteCount(description).toLocaleString("en")} / {DESCRIPTION_MAX_BYTES.toLocaleString("en")} bytes
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="publish-tags">Tags (comma-separated)</Label>
            <Input
              id="publish-tags"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="video editing, transcripts"
            />
            <p
              className={cn(
                "text-xs",
                tagsLength(tags) > TAGS_MAX_CHARS ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {tagsLength(tags)} / {TAGS_MAX_CHARS} characters (YouTube counts commas, and quotes around tags with
              spaces)
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="publish-category">Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger id="publish-category" className="w-full max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {YOUTUBE_CATEGORIES.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Visibility</CardTitle>
          <CardDescription>
            {setup.audited
              ? "Choose who can see it, or schedule it — YouTube publishes it at that time even if this computer is off."
              : "Uploads are private until your Google Cloud project passes YouTube's free API audit (README › Google Cloud setup). You can change the visibility later in YouTube Studio."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup
            value={schedule ? "schedule" : privacy}
            onValueChange={(value) => {
              if (value === "schedule") setSchedule(true);
              else {
                setSchedule(false);
                setPrivacy(value as PrivacyStatus);
              }
            }}
            aria-label="Visibility"
            className="gap-2"
          >
            {PRIVACY_STATUSES.map((status) => (
              <div key={status} className="flex items-center gap-2">
                <RadioGroupItem
                  value={status}
                  id={`privacy-${status}`}
                  disabled={!setup.audited && status !== "private"}
                />
                <Label
                  htmlFor={`privacy-${status}`}
                  className={cn(!setup.audited && status !== "private" && "opacity-50")}
                >
                  {PRIVACY_LABELS[status]}
                </Label>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <RadioGroupItem value="schedule" id="privacy-schedule" disabled={!setup.audited} />
              <Label htmlFor="privacy-schedule" className={cn(!setup.audited && "opacity-50")}>
                Schedule (private until then)
              </Label>
            </div>
          </RadioGroup>
          {schedule ? (
            <div className="space-y-1.5">
              <Label htmlFor="publish-at">Publish at (your local time)</Label>
              <Input
                id="publish-at"
                type="datetime-local"
                value={publishLocal}
                onChange={(e) => setPublishLocal(e.target.value)}
                className="w-auto"
              />
              {publishAt ? (
                <p className="text-xs text-muted-foreground">
                  {new Date(publishAt).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })} (
                  {Intl.DateTimeFormat().resolvedOptions().timeZone})
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Required answers</CardTitle>
          <CardDescription>YouTube asks every uploader these questions.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Is this video made for kids?</legend>
            <RadioGroup
              value={yesNo(madeForKids)}
              onValueChange={(v) => setMadeForKids(v === "yes")}
              className="flex gap-6"
              aria-label="Made for kids"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="no" id="kids-no" />
                <Label htmlFor="kids-no">No, it&apos;s not made for kids</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="yes" id="kids-yes" />
                <Label htmlFor="kids-yes">Yes, it&apos;s made for kids</Label>
              </div>
            </RadioGroup>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Does it contain realistic altered or synthetic (AI-made) content?
            </legend>
            <p className="text-xs text-muted-foreground">
              E.g. a realistic person saying something they didn&apos;t say, or a made-up real-looking event. AI-written
              titles or captions don&apos;t count.
            </p>
            {prefill.containsSyntheticMedia ? (
              <p className="text-xs text-muted-foreground" data-testid="synthetic-default-note">
                Set to “Yes” because this video was made by the generator with a synthetic voice. Change it if you
                replaced the narration with a real recording.
              </p>
            ) : null}
            <RadioGroup
              value={yesNo(synthetic)}
              onValueChange={(v) => setSynthetic(v === "yes")}
              className="flex gap-6"
              aria-label="Altered or synthetic content"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="no" id="synthetic-no" />
                <Label htmlFor="synthetic-no">No</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="yes" id="synthetic-yes" />
                <Label htmlFor="synthetic-yes">Yes</Label>
              </div>
            </RadioGroup>
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Thumbnail</CardTitle>
          <CardDescription>
            Custom thumbnails need a verified channel (youtube.com/verify). If YouTube refuses it, the video is still
            uploaded and you&apos;ll see a note.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {thumbnails.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No thumbnails yet — YouTube will pick a frame.{" "}
              <Link href={target.packagingHref} className="underline underline-offset-2">
                Make one
              </Link>
              .
            </p>
          ) : (
            <RadioGroup
              value={thumbnailId ?? "none"}
              onValueChange={(v) => setThumbnailId(v === "none" ? null : v)}
              aria-label="Thumbnail"
              className="flex flex-wrap gap-3"
            >
              <Label className="flex h-24 w-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border text-xs has-[[data-state=checked]]:border-primary">
                <RadioGroupItem value="none" />
                Let YouTube choose
              </Label>
              {thumbnails.map((thumbnail) => (
                <Label
                  key={thumbnail.id}
                  className="relative cursor-pointer rounded-md border p-1 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:ring-2 has-[[data-state=checked]]:ring-primary/30"
                >
                  <RadioGroupItem
                    value={thumbnail.id}
                    className="absolute top-2 left-2 bg-background"
                    aria-label="Use this thumbnail"
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element -- authenticated media route */}
                  <img
                    src={thumbnail.url}
                    alt=""
                    className={cn("rounded", thumbnail.width > thumbnail.height ? "h-22 w-40" : "h-32 w-18")}
                  />
                </Label>
              ))}
            </RadioGroup>
          )}
        </CardContent>
      </Card>

      <div className="space-y-3">
        {problems.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" aria-label="Before you can upload">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={submit} disabled={pending || blocked || problems.length > 0} data-testid="publish-button">
            {pending ? <Spinner data-icon="inline-start" /> : <Upload data-icon="inline-start" />}
            {schedule
              ? "Upload and schedule"
              : `Upload as ${PRIVACY_LABELS[schedule ? "private" : privacy].toLowerCase()}`}
          </Button>
          <p className="text-xs text-muted-foreground">
            Uploads left today: {Math.max(0, uploadsLeft)} of {quota.uploads.limit} · API units used:{" "}
            {quota.units.used.toLocaleString("en")} of {quota.units.limit.toLocaleString("en")} · resets {resetLocal}
          </p>
        </div>
      </div>
    </div>
  );
}
