"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  type AspectRatio,
  type ExportQuality,
  GENERATOR_DURATIONS,
  GENERATOR_NICHES,
  GENERATOR_TONES,
  type GeneratorNiche,
  type GeneratorTone,
} from "@/lib/constants";
import { frameSize } from "@/lib/generator/timeline";
import type { ProjectSettings } from "@/server/services/generator";

export const NEW_PROJECT_SETTINGS: ProjectSettings = {
  topic: "",
  niche: "education",
  audience: null,
  tone: "friendly",
  notes: null,
  targetDurationSec: 60,
  aspectRatio: "9:16",
  resolution: 1080,
  voice: null,
  voiceRate: 0,
  captionsEnabled: true,
  quality: "standard",
  musicVolumeDb: -18,
};

function durationLabel(seconds: number): string {
  return seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
}

const DEFAULT_VOICE = "__default";

/**
 * The brief and video settings (GEN-01). Only settings the pipeline really supports are offered:
 * English narration with the installed voices, 9:16 or 16:9, 720p or 1080p, 30 s to 5 minutes.
 */
export function BriefForm({
  initial,
  voices,
  submitLabel,
  busy,
  disabled,
  onSubmit,
}: {
  initial: ProjectSettings;
  voices: string[];
  submitLabel: string;
  busy: boolean;
  disabled?: boolean;
  onSubmit: (settings: ProjectSettings) => void;
}) {
  const [settings, setSettings] = useState<ProjectSettings>(initial);
  const set = <K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const size = frameSize(settings.aspectRatio, settings.resolution);

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(settings);
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="gen-topic">Topic</Label>
        <Input
          id="gen-topic"
          value={settings.topic}
          maxLength={200}
          placeholder="For example: why the sea is salty"
          onChange={(event) => set("topic", event.target.value)}
          required
          minLength={3}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="gen-niche">Niche</Label>
          <Select value={settings.niche} onValueChange={(value) => set("niche", value as GeneratorNiche)}>
            <SelectTrigger id="gen-niche" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GENERATOR_NICHES.map((niche) => (
                <SelectItem key={niche.id} value={niche.id}>
                  {niche.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="gen-tone">Tone</Label>
          <Select value={settings.tone} onValueChange={(value) => set("tone", value as GeneratorTone)}>
            <SelectTrigger id="gen-tone" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GENERATOR_TONES.map((tone) => (
                <SelectItem key={tone} value={tone}>
                  {tone[0].toUpperCase() + tone.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="gen-audience">Audience (optional)</Label>
        <Input
          id="gen-audience"
          value={settings.audience ?? ""}
          maxLength={200}
          placeholder="For example: curious teenagers"
          onChange={(event) => set("audience", event.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="gen-notes">Notes for the script (optional)</Label>
        <Textarea
          id="gen-notes"
          value={settings.notes ?? ""}
          maxLength={1000}
          rows={2}
          placeholder="Facts to include, points to avoid, a call to action…"
          onChange={(event) => set("notes", event.target.value)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="gen-duration">Length</Label>
          <Select
            value={String(settings.targetDurationSec)}
            onValueChange={(value) => set("targetDurationSec", Number(value))}
          >
            <SelectTrigger id="gen-duration" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GENERATOR_DURATIONS.map((seconds) => (
                <SelectItem key={seconds} value={String(seconds)}>
                  {durationLabel(seconds)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            About {Math.round((settings.targetDurationSec / 60) * 150)} words of narration.
            {settings.targetDurationSec > 180 && settings.aspectRatio === "9:16"
              ? " YouTube Shorts can be at most 3 minutes."
              : ""}
          </p>
        </div>
        <div className="space-y-2">
          <Label>Shape</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={settings.aspectRatio}
            onValueChange={(value) => value && set("aspectRatio", value as AspectRatio)}
            aria-label="Shape"
          >
            <ToggleGroupItem value="9:16">Vertical 9:16</ToggleGroupItem>
            <ToggleGroupItem value="16:9">Landscape 16:9</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Resolution</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={String(settings.resolution)}
            onValueChange={(value) => value && set("resolution", Number(value))}
            aria-label="Resolution"
          >
            <ToggleGroupItem value="720">720p</ToggleGroupItem>
            <ToggleGroupItem value="1080">1080p</ToggleGroupItem>
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            {size.width} × {size.height}. 720p renders roughly twice as fast.
          </p>
        </div>
        <div className="space-y-2">
          <Label>Quality</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={settings.quality}
            onValueChange={(value) => value && set("quality", value as ExportQuality)}
            aria-label="Quality"
          >
            <ToggleGroupItem value="standard">Standard</ToggleGroupItem>
            <ToggleGroupItem value="high">High</ToggleGroupItem>
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">High is a little sharper and takes 2–3× longer.</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="gen-voice">Voice</Label>
          <Select
            value={settings.voice ?? DEFAULT_VOICE}
            onValueChange={(value) => set("voice", value === DEFAULT_VOICE ? null : value)}
          >
            <SelectTrigger id="gen-voice" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_VOICE}>Default voice</SelectItem>
              {voices.map((voice) => (
                <SelectItem key={voice} value={voice}>
                  {voice}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Narration is in English. Voices are installed on this computer.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="gen-rate">Speaking speed: {settings.voiceRate === 0 ? "normal" : settings.voiceRate}</Label>
          <Slider
            id="gen-rate"
            min={-5}
            max={5}
            step={1}
            value={[settings.voiceRate]}
            onValueChange={([value]) => set("voiceRate", value ?? 0)}
            aria-label="Speaking speed"
          />
        </div>
      </div>

      <div className="flex items-start gap-3">
        <Switch
          id="gen-captions"
          checked={settings.captionsEnabled}
          onCheckedChange={(checked) => set("captionsEnabled", checked)}
        />
        <Label htmlFor="gen-captions" className="block font-normal">
          <span className="font-medium">Burn in captions</span> — timed to the narration, in your default caption style
          (Shorts Editor).
        </Label>
      </div>

      <Button type="submit" disabled={busy || disabled || settings.topic.trim().length < 3} data-testid="brief-submit">
        {busy ? <Spinner data-icon="inline-start" /> : null}
        {submitLabel}
      </Button>
    </form>
  );
}
