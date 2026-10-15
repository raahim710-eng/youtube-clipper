import { CircleCheck, CircleDashed, Info } from "lucide-react";
import { TextWithCode } from "@/components/text-with-code";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { STOCK_PROVIDER_INFO } from "@/lib/generator/stock";
import type { GeneratorSetup } from "@/server/services/generator";
import type { ProviderStatus } from "@/server/services/ai-providers";

function Row({ ok, title, children }: { ok: boolean; title: string; children: React.ReactNode }) {
  const Icon = ok ? CircleCheck : CircleDashed;
  return (
    <li className="flex gap-3">
      <Icon
        className={ok ? "mt-0.5 size-4 shrink-0 text-success" : "mt-0.5 size-4 shrink-0 text-muted-foreground"}
        aria-hidden
      />
      <div className="min-w-0 space-y-1 text-sm">
        <p className="font-medium">
          {title} <span className="sr-only">{ok ? "(ready)" : "(not ready)"}</span>
        </p>
        <div className="space-y-1 text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

/**
 * What each step uses, what it needs, its licence, limits, time and cost — shown before anything runs
 * (Phase 9 brief). Every provider here is free; nothing in this workflow can create a charge.
 */
export function ProviderInfo({ setup, ai }: { setup: GeneratorSetup; ai: ProviderStatus | null }) {
  const stockReady = setup.stock.pexels || setup.stock.pixabay;
  return (
    <Card data-testid="provider-info">
      <CardHeader>
        <CardTitle className="text-base">How videos are made</CardTitle>
        <CardDescription>
          Everything runs on this computer or uses free services. Nothing here costs money, and nothing is published
          until you choose to.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-4">
          <Row
            ok={Boolean(ai?.ready)}
            title={`1. Script — ${ai ? ai.label : "AI provider"}${ai?.model ? ` (${ai.model})` : ""}`}
          >
            <p>
              Writes a title, hook and scenes for your topic and length. You review and edit it before anything else
              happens. AI can get facts wrong, so check them. A small local model takes a few minutes (3–5 minutes
              measured on a 2-core laptop).
            </p>
            {ai?.ready ? (
              <p>{ai.cost}</p>
            ) : (
              <p>
                <TextWithCode
                  text={`${ai?.problem ?? "No AI provider is ready."} ${ai?.fix ?? "Choose one in Settings › AI & processing."}`}
                />
              </p>
            )}
          </Row>
          <Row
            ok={setup.tts.ready}
            title={`2. Narration — ${setup.tts.provider === "sapi" ? "Windows voices (built in)" : "Kokoro (local)"}`}
          >
            <p>
              {setup.tts.provider === "sapi"
                ? "Uses the text-to-speech voices that come with Windows: free, offline, no download. They sound robotic but clear. The voice reports when each word is spoken, so captions match the narration."
                : "Kokoro-82M (Apache-2.0) runs on this computer and sounds natural; it needs about 2 GB of extra downloads."}
            </p>
            <p>
              The voice is synthetic: when publishing, the app suggests telling YouTube the video contains altered or
              synthetic content.
            </p>
            {setup.tts.problem ? (
              <p>
                <TextWithCode text={setup.tts.problem} />
              </p>
            ) : (
              <p>Installed voices: {setup.tts.voices.join(", ") || "default"}.</p>
            )}
          </Row>
          <Row ok={stockReady} title="3. Footage — real moving video, never still images">
            {stockReady ? (
              <p>
                Searching{" "}
                {(["pexels", "pixabay"] as const)
                  .filter((provider) => setup.stock[provider])
                  .map((provider) => STOCK_PROVIDER_INFO[provider].label)
                  .join(" and ")}{" "}
                for each scene. You can swap any clip.
              </p>
            ) : (
              <p data-testid="stock-missing">
                No stock video provider is set up. You can still use clips from your video library or upload your own.
                For stock footage, get a free key at{" "}
                <a href={STOCK_PROVIDER_INFO.pexels.keyUrl} target="_blank" rel="noreferrer" className="underline">
                  pexels.com/api
                </a>
                , add <code className="rounded bg-muted px-1 font-mono text-xs">PEXELS_API_KEY=…</code> to .env and
                restart the app.
              </p>
            )}
            {(["pexels", "pixabay"] as const).map((provider) => {
              const info = STOCK_PROVIDER_INFO[provider];
              return (
                <p key={provider}>
                  {info.label}
                  {provider === "pixabay" ? " (optional)" : ""}: free API key;{" "}
                  <a href={info.licenceUrl} target="_blank" rel="noreferrer" className="underline">
                    {info.licence}
                  </a>{" "}
                  (free to use in your videos; the API terms ask to credit the source and creators, so the app adds
                  credits to the description). {info.limits}
                </p>
              );
            })}
            <p>
              AI video generation isn&apos;t used: the free text-to-video models need a powerful graphics card, and the
              hosted ones are paid. Every scene has to have real moving footage — still images are refused when
              rendering.
            </p>
          </Row>
          <Row ok title="4. Rendering — FFmpeg on this computer">
            <p>
              Trims each clip to its narration, joins scenes with short crossfades, mixes the narration (and your music,
              if you add some) and burns in captions. Measured on a 2-core laptop at 720p: about 1.5 times the
              video&apos;s length (a 1-minute video took about 1.5 minutes); 1080p takes longer. Narration takes 1–3
              seconds per scene.
            </p>
          </Row>
        </ol>
        <p className="mt-4 flex gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Costs: none. The only way this workflow could cost money is if you point the AI provider at a paid service in
          .env — the app never does that on its own.
        </p>
      </CardContent>
    </Card>
  );
}
