import "server-only";
import { type LlmProvider, llmProviderSchema } from "@/lib/constants";
import { db } from "../db";
import { AppError } from "../errors";
import { getEnv } from "../env";

/**
 * Which clip-analysis providers can be used right now (Settings › AI & processing, Clip Finder).
 * Secrets stay in .env (D-020); this only reports whether they're set — never their values.
 */

export type ProviderStatus = {
  id: LlmProvider;
  label: string;
  /** True when this provider is AI. "none" ranks by speech patterns only. */
  isAi: boolean;
  /** Runs on this computer (nothing leaves the machine). */
  local: boolean;
  model: string | null;
  ready: boolean;
  /** What's wrong, in plain words (null when ready). */
  problem: string | null;
  /** How to fix it — env variables and commands (backticks render as code). */
  fix: string | null;
  privacy: string;
  cost: string;
};

let ollamaCache: { at: number; models: string[] | null } | undefined;

async function ollamaModels(baseUrl: string): Promise<string[] | null> {
  if (ollamaCache && Date.now() - ollamaCache.at < 15_000) return ollamaCache.models;
  let models: string[] | null = null;
  try {
    const response = await fetch(new URL("/api/tags", baseUrl), {
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (response.ok) {
      const body = (await response.json()) as { models?: { name?: string; model?: string }[] };
      models = (body.models ?? []).flatMap((m) => [m.name, m.model]).filter((name): name is string => Boolean(name));
    }
  } catch {
    models = null;
  }
  ollamaCache = { at: Date.now(), models };
  return models;
}

export async function getProviderStatuses(): Promise<ProviderStatus[]> {
  const env = getEnv();

  const ollamaModel = env.OLLAMA_MODEL ?? null;
  const installed = await ollamaModels(env.OLLAMA_BASE_URL);
  const wanted = ollamaModel && !ollamaModel.includes(":") ? `${ollamaModel}:latest` : ollamaModel;
  const ollama: ProviderStatus = {
    id: "ollama",
    label: "Ollama (local AI)",
    isAi: true,
    local: true,
    model: ollamaModel,
    ready: false,
    problem: null,
    fix: null,
    privacy: "Runs on this computer. Transcripts never leave it.",
    cost: "Free. Speed depends on your computer.",
  };
  if (!ollamaModel) {
    ollama.problem = "No model chosen.";
    ollama.fix =
      "Set `OLLAMA_MODEL` in .env (for example `qwen2.5:1.5b` on 4–8 GB RAM, `llama3.1:8b` with 16 GB), then restart.";
  } else if (installed === null) {
    ollama.problem = "Ollama isn't running.";
    ollama.fix = "Install it from ollama.com (or `winget install Ollama.Ollama`) and start the Ollama app.";
  } else if (!installed.includes(ollamaModel) && !(wanted && installed.includes(wanted))) {
    ollama.problem = `The model “${ollamaModel}” isn't downloaded.`;
    ollama.fix = `Run \`ollama pull ${ollamaModel}\` in a terminal.`;
  } else {
    ollama.ready = true;
  }

  const geminiModel = env.GEMINI_MODEL ?? null;
  const gemini: ProviderStatus = {
    id: "gemini",
    label: "Google Gemini API",
    isAi: true,
    local: false,
    model: geminiModel,
    ready: Boolean(env.GEMINI_API_KEY && geminiModel),
    problem: !env.GEMINI_API_KEY ? "No API key." : !geminiModel ? "No model chosen." : null,
    fix: !env.GEMINI_API_KEY
      ? "Create a free key at aistudio.google.com/app/apikey, add `GEMINI_API_KEY=…` and `GEMINI_MODEL=…` to .env, then restart."
      : !geminiModel
        ? "Set `GEMINI_MODEL` in .env to a model listed in Google AI Studio, then restart."
        : null,
    privacy: "Sends transcript excerpts to Google. On the free tier Google may use them to improve its products.",
    cost: "Free tier with daily limits that Google can change. Not available in every region.",
  };

  const compatModel = env.OPENAI_COMPAT_MODEL ?? null;
  const compatLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])/.test(env.OPENAI_COMPAT_BASE_URL ?? "");
  const openaiCompatible: ProviderStatus = {
    id: "openai_compatible",
    label: "OpenAI-compatible server",
    isAi: true,
    local: compatLocal,
    model: compatModel,
    ready: Boolean(env.OPENAI_COMPAT_BASE_URL && compatModel),
    problem: env.OPENAI_COMPAT_BASE_URL && compatModel ? null : "Not configured.",
    fix:
      env.OPENAI_COMPAT_BASE_URL && compatModel
        ? null
        : "For a local server such as LM Studio, set `OPENAI_COMPAT_BASE_URL` (e.g. `http://127.0.0.1:1234/v1`) and `OPENAI_COMPAT_MODEL` in .env, then restart.",
    privacy: compatLocal ? "Local server on this computer." : "Sends transcript excerpts to that server.",
    cost: compatLocal ? "Free." : "Depends on the service — don't add paid services without deciding to.",
  };

  const none: ProviderStatus = {
    id: "none",
    label: "Speech patterns only (no AI)",
    isAi: false,
    local: true,
    model: null,
    ready: true,
    problem: null,
    fix: null,
    privacy: "Runs on this computer.",
    cost: "Free and fast. Ranks by pace, loudness, questions and pauses — no AI judgement, titles or reasons.",
  };

  return [ollama, gemini, openaiCompatible, none];
}

export type AiSettings = {
  llmProvider: LlmProvider;
  autoTranscribe: boolean;
  defaultLanguage: string;
  /** Voice/tone guidance for packaging (PKG-07). */
  channelStyleNotes: string | null;
};

export async function getAiSettings(userId: string): Promise<AiSettings> {
  const settings = await db.userSettings.findUnique({ where: { userId } });
  return {
    llmProvider: llmProviderSchema.catch("ollama").parse(settings?.llmProvider ?? "ollama"),
    autoTranscribe: settings?.autoTranscribe ?? true,
    defaultLanguage: settings?.defaultLanguage ?? "auto",
    channelStyleNotes: settings?.channelStyleNotes ?? null,
  };
}

/**
 * The owner's chosen AI provider, if it can be used right now; otherwise an error that explains the fix
 * (missing key, Ollama not running, AI turned off). Nothing is queued and nothing falls back silently (D-035).
 */
export async function requireReadyAiProvider(userId: string, purpose: string): Promise<LlmProvider> {
  const { llmProvider } = await getAiSettings(userId);
  if (llmProvider === "none") {
    throw new AppError(
      "VALIDATION",
      `${purpose} needs an AI model, and AI is turned off. Choose a provider in Settings › AI & processing.`,
    );
  }
  const status = (await getProviderStatuses()).find((p) => p.id === llmProvider);
  if (!status?.ready) {
    throw new AppError(
      "CONFIGURATION",
      `${status?.label ?? llmProvider} isn't ready: ${status?.problem ?? "not configured"} ${status?.fix ?? ""}`.trim(),
    );
  }
  return llmProvider;
}

export async function updateAiSettings(userId: string, settings: AiSettings): Promise<void> {
  await db.userSettings.upsert({ where: { userId }, create: { userId, ...settings }, update: settings });
}

/** Common transcription languages for the settings menu (Whisper supports many more via "auto"). */
export const TRANSCRIPTION_LANGUAGES: { code: string; label: string }[] = [
  { code: "auto", label: "Detect automatically" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "hi", label: "Hindi" },
  { code: "ur", label: "Urdu" },
  { code: "ar", label: "Arabic" },
  { code: "tr", label: "Turkish" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
];
