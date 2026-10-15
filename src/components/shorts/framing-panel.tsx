"use client";

import { AlertCircle, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { retryReframeAction } from "@/app/(app)/shorts/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import { REFRAME_MODE_LABELS, REFRAME_MODES, type ReframeMode } from "@/lib/constants";
import { cropBox, needsHorizontalFraming } from "@/lib/shorts/framing";
import type { ShortStatusView } from "@/server/services/shorts";

const MODE_HELP: Record<ReframeMode, string> = {
  auto: "Finds the main face in each shot and keeps it in view.",
  center: "Keeps the middle of the picture.",
  blur: "Shows the whole picture, with a blurred copy filling the space above and below.",
  manual: "You choose which part of the picture stays in view.",
};

/** Framing tab (SHORT-03). */
export function FramingPanel({
  shortId,
  mode,
  manualX,
  sourceWidth,
  sourceHeight,
  reframe,
  videoRef,
  currentMs,
  onChange,
  onStatusChange,
}: {
  shortId: string;
  mode: ReframeMode;
  manualX: number;
  sourceWidth: number;
  sourceHeight: number;
  reframe: ShortStatusView["reframe"];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentMs: number;
  onChange: (patch: { reframeMode?: ReframeMode; manualX?: number }) => void;
  onStatusChange: () => void;
}) {
  const horizontal = needsHorizontalFraming(sourceWidth, sourceHeight);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-5">
      {!horizontal ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          This video is already vertical, so it fills the Short without cropping. Framing options make no difference.
        </p>
      ) : null}
      <RadioGroup
        value={mode}
        onValueChange={(value) => onChange({ reframeMode: value as ReframeMode })}
        aria-label="Framing"
        className="gap-3"
      >
        {REFRAME_MODES.map((value) => (
          <div
            key={value}
            className="flex items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary"
          >
            <RadioGroupItem
              value={value}
              id={`framing-${value}`}
              className="mt-0.5"
              disabled={!horizontal && value !== "center"}
            />
            <div className="space-y-0.5">
              <Label htmlFor={`framing-${value}`}>{REFRAME_MODE_LABELS[value]}</Label>
              <p className="text-xs text-muted-foreground">{MODE_HELP[value]}</p>
            </div>
          </div>
        ))}
      </RadioGroup>

      {mode === "auto" && horizontal ? (
        <AutoStatus
          reframe={reframe}
          pending={pending}
          onRetry={() =>
            startTransition(async () => {
              const result = await retryReframeAction(shortId);
              if (!result.ok) toast.error(result.error);
              onStatusChange();
            })
          }
        />
      ) : null}

      {mode === "manual" && horizontal ? (
        <ManualPicker
          manualX={manualX}
          sourceWidth={sourceWidth}
          sourceHeight={sourceHeight}
          videoRef={videoRef}
          currentMs={currentMs}
          onChange={(x) => onChange({ manualX: x })}
        />
      ) : null}
    </div>
  );
}

function AutoStatus({
  reframe,
  pending,
  onRetry,
}: {
  reframe: ShortStatusView["reframe"];
  pending: boolean;
  onRetry: () => void;
}) {
  if (reframe.job || reframe.status === "processing") {
    return (
      <div className="space-y-2 rounded-lg border p-3" role="status">
        <p className="text-sm font-medium">Finding faces…</p>
        <Progress value={reframe.job?.progress ?? 0} aria-label="Face tracking progress" />
        <p className="text-xs text-muted-foreground">
          {reframe.job?.status === "queued" ? "Waiting for the media worker." : (reframe.job?.message ?? "Working")}.
          The preview stays centred until this finishes.
        </p>
      </div>
    );
  }
  if (reframe.status === "failed") {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Face tracking failed</AlertTitle>
        <AlertDescription>
          <p>{reframe.error}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" disabled={pending} onClick={onRetry}>
            <RotateCcw data-icon="inline-start" />
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (reframe.status === "ready" && reframe.covers) {
    return (
      <div className="space-y-1 rounded-lg border p-3 text-sm" data-testid="auto-framing-ready">
        <p className="font-medium">Following faces</p>
        {reframe.warnings.length > 0 ? (
          reframe.warnings.map((warning) => (
            <p key={warning} className="text-xs text-muted-foreground">
              {warning}
            </p>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">Faces were found and the crop follows the main speaker.</p>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
      <p className="text-muted-foreground">Face tracking hasn&apos;t run for this part of the video yet.</p>
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onRetry}>
        Find faces
      </Button>
    </div>
  );
}

/** Shows the current source frame with the crop box; drag the box (or use the slider) to choose the position. */
function ManualPicker({
  manualX,
  sourceWidth,
  sourceHeight,
  videoRef,
  currentMs,
  onChange,
}: {
  manualX: number;
  sourceWidth: number;
  sourceHeight: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentMs: number;
  onChange: (x: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const box = cropBox(sourceWidth, sourceHeight);
  const widthPct = (box.width / sourceWidth) * 100;
  const leftPct = Math.min(Math.max(manualX * 100 - widthPct / 2, 0), 100 - widthPct);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  }, [currentMs, videoRef]);

  function moveTo(clientX: number) {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onChange(Math.round(x * 1000) / 1000);
  }

  return (
    <div className="space-y-3">
      <div
        ref={areaRef}
        className="relative w-full cursor-ew-resize overflow-hidden rounded-md bg-muted touch-none"
        style={{ aspectRatio: `${sourceWidth} / ${sourceHeight}` }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          moveTo(event.clientX);
        }}
        onPointerMove={(event) => dragging && moveTo(event.clientX)}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        data-testid="manual-framing"
      >
        <canvas
          ref={canvasRef}
          width={320}
          height={Math.round((320 * sourceHeight) / sourceWidth)}
          className="size-full"
          aria-hidden
        />
        <div className="absolute inset-y-0 left-0 bg-black/55" style={{ width: `${leftPct}%` }} aria-hidden />
        <div
          className="absolute inset-y-0 right-0 bg-black/55"
          style={{ width: `${100 - leftPct - widthPct}%` }}
          aria-hidden
        />
        <div
          className="absolute inset-y-0 border-2 border-white shadow"
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          aria-hidden
        />
      </div>
      <div className="space-y-1.5">
        <Label id="manual-x-label">Horizontal position</Label>
        <Slider
          aria-labelledby="manual-x-label"
          min={0}
          max={1}
          step={0.005}
          value={[manualX]}
          onValueChange={([x]) => onChange(x)}
          className="py-2"
        />
      </div>
    </div>
  );
}
