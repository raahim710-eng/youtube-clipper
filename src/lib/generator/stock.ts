import { z } from "zod";

/**
 * Stock footage candidates (GEN-04, D-011). Files come only from the providers' own media hosts and are
 * kept in `stock-cache/{provider}/{id}.mp4`; the same rules are enforced by the media worker.
 */

export const STOCK_PROVIDERS = ["pexels", "pixabay"] as const;
export type StockProvider = (typeof STOCK_PROVIDERS)[number];

export const STOCK_PROVIDER_INFO: Record<
  StockProvider,
  { label: string; licence: string; licenceUrl: string; keyUrl: string; limits: string }
> = {
  pexels: {
    label: "Pexels",
    licence: "Pexels License",
    licenceUrl: "https://www.pexels.com/license/",
    keyUrl: "https://www.pexels.com/api/",
    limits: "Free. 200 requests per hour and 20,000 per month by default. Searches are cached for 24 hours.",
  },
  pixabay: {
    label: "Pixabay",
    licence: "Pixabay Content License",
    licenceUrl: "https://pixabay.com/service/license-summary/",
    keyUrl: "https://pixabay.com/api/docs/",
    limits: "Free. 100 requests per minute. Searches are cached for 24 hours, as Pixabay requires.",
  },
};

const ALLOWED_HOSTS: Record<StockProvider, string[]> = {
  pexels: ["videos.pexels.com", "player.vimeo.com"],
  pixabay: ["cdn.pixabay.com"],
};

export function isAllowedDownload(provider: StockProvider, url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_HOSTS[provider].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function stockFilePath(provider: StockProvider, providerAssetId: string): string {
  return `stock-cache/${provider}/${providerAssetId}.mp4`;
}

const httpsUrl = z
  .string()
  .max(1000)
  .refine((value) => value.startsWith("https://"), "must be https");

export const stockCandidateSchema = z
  .object({
    provider: z.enum(STOCK_PROVIDERS),
    providerAssetId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    pageUrl: httpsUrl,
    creatorName: z.string().trim().min(1).max(200),
    creatorUrl: httpsUrl.nullable(),
    downloadUrl: httpsUrl,
    previewImageUrl: httpsUrl.nullable(),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    durationMs: z.number().int().nonnegative().max(3_600_000),
    licenseName: z.string().max(100),
    /** Set once the file is in the cache. */
    filePath: z.string().max(200).nullable(),
  })
  .refine((c) => isAllowedDownload(c.provider, c.downloadUrl), "download host not allowed")
  .refine((c) => c.filePath === null || c.filePath === stockFilePath(c.provider, c.providerAssetId), "bad file path");
export type StockCandidate = z.infer<typeof stockCandidateSchema>;

export const stockCandidatesSchema = z.array(stockCandidateSchema).max(10);
