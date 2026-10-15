"use client";

import { CircleCheck, CircleDashed } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateAiSettingsAction } from "@/app/(app)/settings/ai/actions";
import { TextWithCode } from "@/components/text-with-code";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { LlmProvider } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { AiSettings, ProviderStatus } from "@/server/services/ai-providers";

/** Settings › AI & processing: which AI rates clips, transcription language, auto-transcribe. */
export function AiSettingsForm({
  settings,
  providers,
  languages,
}: {
  settings: AiSettings;
  providers: ProviderStatus[];
  languages: { code: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [provider, setProvider] = useState<LlmProvider>(settings.llmProvider);
  const [autoTranscribe, setAutoTranscribe] = useState(settings.autoTranscribe);
  const [language, setLanguage] = useState(settings.defaultLanguage);
  const [styleNotes, setStyleNotes] = useState(settings.channelStyleNotes ?? "");

  function save() {
    startTransition(async () => {
      const result = await updateAiSettingsAction({
        llmProvider: provider,
        autoTranscribe,
        defaultLanguage: language,
        channelStyleNotes: styleNotes,
      });
      if (!result.ok) toast.error(result.error);
      else toast.success("Settings saved.");
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Who rates clip suggestions</legend>
        <RadioGroup value={provider} onValueChange={(value) => setProvider(value as LlmProvider)} className="gap-2">
          {providers.map((option) => (
            <Label
              key={option.id}
              htmlFor={`provider-${option.id}`}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal",
                provider === option.id && "border-primary/60 bg-primary/5",
              )}
            >
              <RadioGroupItem id={`provider-${option.id}`} value={option.id} className="mt-0.5" />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {option.label}
                  {option.model ? (
                    <span className="font-mono text-xs text-muted-foreground">{option.model}</span>
                  ) : null}
                  {option.ready ? (
                    <Badge variant="outline" className="gap-1 font-normal text-success">
                      <CircleCheck className="size-3" aria-hidden />
                      Ready
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
                      <CircleDashed className="size-3" aria-hidden />
                      Not set up
                    </Badge>
                  )}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {option.privacy} {option.cost}
                </span>
                {!option.ready && option.fix ? (
                  <span className="block text-xs">
                    {option.problem} <TextWithCode text={option.fix} />
                  </span>
                ) : null}
              </span>
            </Label>
          ))}
        </RadioGroup>
        {provider === "gemini" ? (
          <p className="text-xs text-warning">
            With Gemini, transcript excerpts are sent to Google. On the free tier Google may use them to improve its
            products.
          </p>
        ) : null}
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="language">Transcription language</Label>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger id="language" className="w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {languages.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Choosing the language is slightly faster and more reliable than detection.
        </p>
      </div>

      <div className="flex items-start gap-3">
        <Switch id="auto-transcribe" checked={autoTranscribe} onCheckedChange={setAutoTranscribe} />
        <div className="space-y-1">
          <Label htmlFor="auto-transcribe">Transcribe new videos automatically</Label>
          <p className="text-xs text-muted-foreground">
            Starts right after a new upload is processed. Turn off on a slow computer if you only want some videos
            transcribed.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="channel-style">Channel style for packaging (optional)</Label>
        <Textarea
          id="channel-style"
          value={styleNotes}
          maxLength={1000}
          rows={3}
          placeholder="e.g. Friendly and practical, no hype. Audience: beginner video editors. British spelling."
          onChange={(event) => setStyleNotes(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Used every time titles, descriptions and hooks are written, so they sound like your channel.
        </p>
      </div>

      <Button onClick={save} disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        Save settings
      </Button>
    </div>
  );
}
