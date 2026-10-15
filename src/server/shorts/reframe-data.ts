import { z } from "zod";

/** The `media.reframe` result stored on a Short (`reframeJson`): crop-centre keyframes in source-video time. */
export const reframeDataSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  model: z.string().max(100).nullable(),
  keyframes: z
    .array(z.object({ tMs: z.number().int().nonnegative(), x: z.number().min(0).max(1) }))
    .min(1)
    .max(500),
  shots: z.number().int().nonnegative(),
  shotsWithFace: z.number().int().nonnegative(),
  faceSamples: z.number().int().nonnegative(),
  samples: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(300)).max(10),
});
export type ReframeData = z.infer<typeof reframeDataSchema>;
