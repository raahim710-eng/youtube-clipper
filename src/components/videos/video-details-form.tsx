"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateVideoDetailsAction } from "@/app/(app)/videos/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

/** LIB-05: edit a video's title and notes (notes are used for AI packaging later). */
export function VideoDetailsForm({ videoId, title, notes }: { videoId: string; title: string; notes: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await updateVideoDetailsAction(videoId, {
        title: String(form.get("title") ?? ""),
        notes: String(form.get("notes") ?? ""),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success("Details saved.");
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <FieldGroup>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="title">Title</FieldLabel>
          <Input id="title" name="title" defaultValue={title} maxLength={200} required />
        </Field>
        <Field>
          <FieldLabel htmlFor="notes">Notes</FieldLabel>
          <Textarea id="notes" name="notes" defaultValue={notes ?? ""} maxLength={5000} rows={4} />
          <FieldDescription>
            Optional. Topic, audience or anything the AI should know when packaging this video.
          </FieldDescription>
        </Field>
      </FieldGroup>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        {pending ? "Saving…" : "Save details"}
      </Button>
    </form>
  );
}
