"use client";

import { Clock, MoreHorizontal, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useTransition } from "react";
import { toast } from "sonner";
import { setDefaultCaptionStyleAction } from "@/app/(app)/shorts/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type Caption, type CaptionWord, buildCaptions, normalizeCaptions } from "@/lib/shorts/captions";
import {
  CAPTION_BACKGROUND_LABELS,
  CAPTION_BACKGROUNDS,
  CAPTION_FONTS,
  CAPTION_PRESETS,
  type CaptionFont,
  type CaptionStyle,
} from "@/lib/shorts/caption-style";
import { formatTimecode } from "@/lib/time";
import { cn } from "@/lib/utils";

type Props = {
  enabled: boolean;
  captions: Caption[];
  style: CaptionStyle;
  hookText: string | null;
  startMs: number;
  endMs: number;
  currentMs: number;
  playing: boolean;
  words: CaptionWord[];
  transcriptReady: boolean;
  onChange: (patch: {
    captionsEnabled?: boolean;
    captions?: Caption[];
    captionStyle?: CaptionStyle;
    hookText?: string | null;
  }) => void;
  onSeek: (ms: number) => void;
};

/** Captions tab (SHORT-04, SHORT-08): text and timing of each caption, style, and the optional hook text. */
export function CaptionsPanel(props: Props) {
  const { enabled, captions, style, startMs, endMs, onChange } = props;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label htmlFor="captions-enabled" className="text-sm font-medium">
            Show captions
          </Label>
          <p className="text-xs text-muted-foreground">
            Burned into the video. Made from the transcript — edit any wording that isn&apos;t right.
          </p>
        </div>
        <Switch
          id="captions-enabled"
          checked={enabled}
          onCheckedChange={(checked) => onChange({ captionsEnabled: checked })}
        />
      </div>

      {enabled ? (
        <>
          <StyleControls style={style} onChange={(captionStyle) => onChange({ captionStyle })} />
          <CaptionList {...props} />
        </>
      ) : null}

      <div className="space-y-2 border-t pt-4">
        <Label htmlFor="hook-text">Title text at the start (optional)</Label>
        <Input
          id="hook-text"
          value={props.hookText ?? ""}
          maxLength={120}
          placeholder="e.g. The one mistake everyone makes"
          onChange={(event) => onChange({ hookText: event.target.value || null })}
        />
        <p className="text-xs text-muted-foreground">Shown at the top for the first 3 seconds, in the caption font.</p>
      </div>
      <p className="sr-only">
        Short from {formatTimecode(startMs)} to {formatTimecode(endMs)} with {captions.length} captions.
      </p>
    </div>
  );
}

function StyleControls({ style, onChange }: { style: CaptionStyle; onChange: (style: CaptionStyle) => void }) {
  const [pending, startTransition] = useTransition();
  const set = (patch: Partial<CaptionStyle>) => onChange({ ...style, ...patch, presetId: "custom" });

  return (
    <fieldset className="space-y-4 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">Style</legend>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Style presets">
        {CAPTION_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            type="button"
            size="sm"
            variant={style.presetId === preset.id ? "default" : "outline"}
            aria-pressed={style.presetId === preset.id}
            onClick={() => onChange(preset.style)}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="caption-font">Font</Label>
          <Select value={style.font} onValueChange={(font) => set({ font: font as CaptionFont })}>
            <SelectTrigger id="caption-font" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CAPTION_FONTS).map(([id, font]) => (
                <SelectItem key={id} value={id}>
                  {font.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label id="caption-size-label">Size ({style.size})</Label>
          <Slider
            aria-labelledby="caption-size-label"
            min={40}
            max={160}
            step={2}
            value={[style.size]}
            onValueChange={([size]) => set({ size })}
            className="py-2"
          />
        </div>
        <div className="flex items-center gap-3">
          <Label htmlFor="caption-color">Text colour</Label>
          <input
            id="caption-color"
            type="color"
            value={style.textColor}
            onChange={(event) => set({ textColor: event.target.value.toUpperCase() })}
            className="h-8 w-12 cursor-pointer rounded border bg-transparent"
          />
        </div>
        <div className="flex items-center gap-3">
          <Switch
            id="caption-uppercase"
            checked={style.uppercase}
            onCheckedChange={(uppercase) => set({ uppercase })}
          />
          <Label htmlFor="caption-uppercase">Capital letters</Label>
        </div>
        <div className="space-y-1.5">
          <Label id="caption-background-label">Background</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-labelledby="caption-background-label"
            value={style.background}
            onValueChange={(value) => {
              if (value) set({ background: value as CaptionStyle["background"] });
            }}
          >
            {CAPTION_BACKGROUNDS.map((background) => (
              <ToggleGroupItem key={background} value={background}>
                {CAPTION_BACKGROUND_LABELS[background]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {style.background !== "none" ? (
          <div className="flex items-center gap-3">
            <Label htmlFor="caption-background-color">
              {style.background === "box" ? "Box colour" : "Outline colour"}
            </Label>
            <input
              id="caption-background-color"
              type="color"
              value={style.backgroundColor}
              onChange={(event) => set({ backgroundColor: event.target.value.toUpperCase() })}
              className="h-8 w-12 cursor-pointer rounded border bg-transparent"
            />
          </div>
        ) : null}
        {style.background === "box" ? (
          <div className="space-y-1.5">
            <Label id="caption-opacity-label">Box opacity ({style.backgroundOpacity}%)</Label>
            <Slider
              aria-labelledby="caption-opacity-label"
              min={0}
              max={100}
              step={5}
              value={[style.backgroundOpacity]}
              onValueChange={([backgroundOpacity]) => set({ backgroundOpacity })}
              className="py-2"
            />
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label id="caption-position-label">Position ({style.positionY}% from the top)</Label>
          <Slider
            aria-labelledby="caption-position-label"
            min={8}
            max={92}
            step={1}
            value={[style.positionY]}
            onValueChange={([positionY]) => set({ positionY })}
            className="py-2"
          />
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await setDefaultCaptionStyleAction(style);
            if (result.ok) toast.success("New Shorts will use this caption style.");
            else toast.error(result.error);
          })
        }
      >
        Use this style for new Shorts
      </Button>
    </fieldset>
  );
}

function CaptionList({
  captions,
  startMs,
  endMs,
  currentMs,
  playing,
  words,
  transcriptReady,
  onChange,
  onSeek,
}: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  const activeIndex = captions.findIndex((c) => c.startMs <= currentMs && currentMs < c.endMs);

  useEffect(() => {
    if (!playing || activeIndex < 0) return;
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, playing]);

  function setTiming(index: number, patch: Partial<Caption>) {
    const next = captions.map((caption, i) => (i === index ? { ...caption, ...patch } : caption));
    onChange({ captions: normalizeCaptions(next, startMs, endMs) });
  }

  function addAtPlayhead() {
    const at = Math.min(Math.max(currentMs, startMs), endMs - 300);
    const added = { startMs: at, endMs: Math.min(endMs, at + 1_500), text: "New caption" };
    onChange({ captions: normalizeCaptions([...captions, added], startMs, endMs) });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Captions ({captions.length})</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={addAtPlayhead}>
            <Plus data-icon="inline-start" />
            Add at playhead
          </Button>
          {transcriptReady ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (
                  window.confirm("Replace all captions with fresh ones from the transcript? Your edits will be lost.")
                ) {
                  onChange({ captions: buildCaptions(words, startMs, endMs) });
                }
              }}
            >
              <RotateCcw data-icon="inline-start" />
              Rebuild from transcript
            </Button>
          ) : null}
        </div>
      </div>
      {!transcriptReady && captions.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          This video has no transcript, so there are no automatic captions. Transcribe it on the video page, or add
          captions by hand.
        </p>
      ) : null}
      <ol ref={listRef} className="max-h-[28rem] space-y-1.5 overflow-y-auto pr-1" aria-label="Captions">
        {captions.map((caption, index) => (
          <li
            key={caption.startMs}
            className={cn(
              "flex items-center gap-2 rounded-md border p-1.5",
              index === activeIndex && "border-primary bg-primary/5",
            )}
          >
            <button
              type="button"
              className="w-24 shrink-0 text-left text-xs text-muted-foreground tabular-nums hover:text-foreground"
              onClick={() => onSeek(caption.startMs)}
              aria-label={`Go to caption ${index + 1}`}
            >
              {formatTimecode(caption.startMs - startMs)}–{formatTimecode(caption.endMs - startMs)}
            </button>
            <Input
              value={caption.text}
              maxLength={200}
              aria-label={`Caption ${index + 1} text`}
              className="h-8"
              onChange={(event) =>
                onChange({ captions: captions.map((c, i) => (i === index ? { ...c, text: event.target.value } : c)) })
              }
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`More for caption ${index + 1}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={currentMs >= caption.endMs - 100 || currentMs < startMs}
                  onSelect={() => setTiming(index, { startMs: currentMs })}
                >
                  <Clock />
                  Start at playhead
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={currentMs <= caption.startMs + 100 || currentMs > endMs}
                  onSelect={() => setTiming(index, { endMs: currentMs })}
                >
                  <Clock />
                  End at playhead
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => onChange({ captions: captions.filter((_, i) => i !== index) })}
                >
                  <Trash2 />
                  Delete caption
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ol>
    </div>
  );
}
