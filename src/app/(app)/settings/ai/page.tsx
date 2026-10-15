import type { Metadata } from "next";
import { AiSettingsForm } from "@/components/settings/ai-settings-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getEnv } from "@/server/env";
import { requireUser } from "@/server/session";
import { getAiSettings, getProviderStatuses, TRANSCRIPTION_LANGUAGES } from "@/server/services/ai-providers";

export const metadata: Metadata = { title: "AI & processing" };

export default async function AiSettingsPage() {
  const user = await requireUser();
  const [settings, providers] = await Promise.all([getAiSettings(user.id), getProviderStatuses()]);
  const env = getEnv();

  const fixed: [string, string][] = [
    ["Transcription", `${env.TRANSCRIPTION_PROVIDER}, model “${env.WHISPER_MODEL}” (WHISPER_MODEL)`],
    ["Clip length", `${env.CLIP_MIN_SEC}–${env.CLIP_MAX_SEC} seconds (CLIP_MIN_SEC / CLIP_MAX_SEC)`],
    ["Suggestions per video", `up to ${env.CLIP_MAX_SUGGESTIONS} (CLIP_MAX_SUGGESTIONS)`],
    [
      "Moments sent to the AI",
      `${env.CLIP_AI_CANDIDATES}, ${env.CLIP_AI_BATCH_SIZE} per request (CLIP_AI_CANDIDATES / CLIP_AI_BATCH_SIZE)`,
    ],
  ];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI & processing</CardTitle>
          <CardDescription>
            Choose who rates clip suggestions. API keys and model names live in your .env file (never in the app), so
            changing them needs a restart.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AiSettingsForm settings={settings} providers={providers} languages={TRANSCRIPTION_LANGUAGES} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Set in .env</CardTitle>
          <CardDescription>
            Tune these for your computer. Bigger speech models are more accurate but slower.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[180px_1fr]">
            {fixed.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </>
  );
}
