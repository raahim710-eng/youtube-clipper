import type { CSSProperties } from "react";
import { z } from "zod";

/**
 * Caption styles (SHORT-04). `renderStyle()` turns a style into the exact numbers the export uses
 * (media-worker/src/media_worker/shorts/ass.py → libass, 1080×1920), and `previewTextStyle()` draws
 * the same numbers in the editor, so preview and export match (SHORT-06).
 */

export const FRAME_WIDTH = 1080;
export const FRAME_HEIGHT = 1920;
const MARGIN_X = 90;

/**
 * Bundled fonts (Geist, OFL — media-worker/assets/fonts; the app loads the same family from `geist`).
 * libass sizes text so that the font's ascent + descent (Windows metrics) equals the font size, while
 * CSS sizes the em square — `emRatio` converts between them (unitsPerEm / (winAscent + winDescent)).
 */
export const CAPTION_FONTS = {
  "geist-black": {
    label: "Geist Black",
    assName: "Geist Black",
    bold: false,
    cssFamily: "var(--font-geist-sans)",
    weight: 900,
    emRatio: 1000 / (1088 + 262),
  },
  "geist-bold": {
    label: "Geist Bold",
    assName: "Geist",
    bold: true,
    cssFamily: "var(--font-geist-sans)",
    weight: 700,
    emRatio: 1000 / (1088 + 262),
  },
  "geist-mono": {
    label: "Geist Mono Bold",
    assName: "Geist Mono",
    bold: true,
    cssFamily: "var(--font-geist-mono)",
    weight: 700,
    emRatio: 1000 / (1088 + 394),
  },
} as const;
export type CaptionFont = keyof typeof CAPTION_FONTS;
const FONT_IDS = Object.keys(CAPTION_FONTS) as [CaptionFont, ...CaptionFont[]];

export const CAPTION_BACKGROUNDS = ["none", "outline", "box"] as const;
export const CAPTION_BACKGROUND_LABELS: Record<(typeof CAPTION_BACKGROUNDS)[number], string> = {
  none: "None",
  outline: "Outline",
  box: "Box",
};

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #FFFFFF");

export const captionStyleSchema = z.object({
  presetId: z.string().max(30),
  font: z.enum(FONT_IDS),
  /** Line height in pixels on the 1080×1920 frame. */
  size: z.number().int().min(40).max(160),
  textColor: hexColor,
  background: z.enum(CAPTION_BACKGROUNDS),
  backgroundColor: hexColor,
  backgroundOpacity: z.number().int().min(0).max(100),
  /** Vertical centre of the caption, % from the top. */
  positionY: z.number().int().min(8).max(92),
  uppercase: z.boolean(),
});
export type CaptionStyle = z.infer<typeof captionStyleSchema>;

export const CAPTION_PRESETS: { id: string; label: string; style: CaptionStyle }[] = [
  {
    id: "bold",
    label: "Bold white",
    style: {
      presetId: "bold",
      font: "geist-black",
      size: 96,
      textColor: "#FFFFFF",
      background: "outline",
      backgroundColor: "#000000",
      backgroundOpacity: 100,
      positionY: 70,
      uppercase: true,
    },
  },
  {
    id: "pop",
    label: "Yellow pop",
    style: {
      presetId: "pop",
      font: "geist-black",
      size: 104,
      textColor: "#FFE14D",
      background: "outline",
      backgroundColor: "#000000",
      backgroundOpacity: 100,
      positionY: 66,
      uppercase: true,
    },
  },
  {
    id: "boxed",
    label: "Boxed",
    style: {
      presetId: "boxed",
      font: "geist-bold",
      size: 80,
      textColor: "#FFFFFF",
      background: "box",
      backgroundColor: "#000000",
      backgroundOpacity: 75,
      positionY: 72,
      uppercase: false,
    },
  },
  {
    id: "clean",
    label: "Clean",
    style: {
      presetId: "clean",
      font: "geist-bold",
      size: 76,
      textColor: "#FFFFFF",
      background: "none",
      backgroundColor: "#000000",
      backgroundOpacity: 100,
      positionY: 78,
      uppercase: false,
    },
  },
  {
    id: "mono",
    label: "Typewriter",
    style: {
      presetId: "mono",
      font: "geist-mono",
      size: 72,
      textColor: "#111111",
      background: "box",
      backgroundColor: "#FFFFFF",
      backgroundOpacity: 100,
      positionY: 74,
      uppercase: false,
    },
  },
];

export const DEFAULT_CAPTION_STYLE: CaptionStyle = CAPTION_PRESETS[0].style;

/** Reads a stored style, falling back to the default if it is missing or from an older version. */
export function parseCaptionStyle(json: string | null | undefined): CaptionStyle {
  if (!json) return DEFAULT_CAPTION_STYLE;
  try {
    const parsed = captionStyleSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : DEFAULT_CAPTION_STYLE;
  } catch {
    return DEFAULT_CAPTION_STYLE;
  }
}

/** Exactly what the worker's `TextStyle` (ass.py) expects. */
export type RenderTextStyle = {
  fontName: string;
  bold: boolean;
  fontSize: number;
  textColor: string;
  background: "none" | "outline" | "box";
  backgroundColor: string;
  /** ASS alpha: 0 = opaque, 255 = invisible. */
  backgroundAlpha: number;
  /** Outline thickness, or the padding around the text for a box. */
  outline: number;
  centerY: number;
  marginX: number;
};

export function renderStyle(style: CaptionStyle): RenderTextStyle {
  const font = CAPTION_FONTS[style.font];
  return {
    fontName: font.assName,
    bold: font.bold,
    fontSize: style.size,
    textColor: style.textColor.toUpperCase(),
    background: style.background,
    backgroundColor: style.backgroundColor.toUpperCase(),
    backgroundAlpha: Math.round(255 * (1 - style.backgroundOpacity / 100)),
    outline: style.background === "box" ? Math.round(style.size * 0.2) : Math.round(style.size * 0.075),
    centerY: Math.round((FRAME_HEIGHT * style.positionY) / 100),
    marginX: MARGIN_X,
  };
}

/** The optional hook/title text at the top (SHORT-08): same font, dark text on a white box. */
export function hookStyle(style: CaptionStyle): CaptionStyle {
  return {
    ...style,
    presetId: "hook",
    size: Math.max(48, Math.round(style.size * 0.75)),
    textColor: "#111111",
    background: "box",
    backgroundColor: "#FFFFFF",
    backgroundOpacity: 100,
    positionY: 16,
    uppercase: false,
  };
}

export const HOOK_DURATION_MS = 3_000;

export function captionText(text: string, style: CaptionStyle): string {
  return style.uppercase ? text.toUpperCase() : text;
}

/** Container-relative length: the preview frame is a CSS container, so 1080 px ↔ 100cqw. */
function frame(px: number): string {
  return `${((px / FRAME_WIDTH) * 100).toFixed(3)}cqw`;
}

function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${(1 - alpha / 255).toFixed(3)})`;
}

/** CSS for a caption block in the 9:16 preview (wrapper = positioned block, text = the inline text). */
export function previewTextStyle(style: CaptionStyle): { wrapper: CSSProperties; text: CSSProperties } {
  const render = renderStyle(style);
  const font = CAPTION_FONTS[style.font];
  const text: CSSProperties = {
    fontFamily: font.cssFamily,
    fontWeight: font.weight,
    fontSize: frame(render.fontSize * font.emRatio),
    lineHeight: frame(render.fontSize),
    color: render.textColor,
    whiteSpace: "pre-line",
  };
  if (render.background === "outline") {
    text.WebkitTextStroke = `${frame(render.outline * 2)} ${rgba(render.backgroundColor, render.backgroundAlpha)}`;
    text.paintOrder = "stroke fill";
  } else if (render.background === "box") {
    text.backgroundColor = rgba(render.backgroundColor, render.backgroundAlpha);
    text.padding = `${frame(render.outline * 0.6)} ${frame(render.outline)}`;
    text.boxDecorationBreak = "clone";
    text.WebkitBoxDecorationBreak = "clone";
  }
  return {
    wrapper: {
      position: "absolute",
      left: "50%",
      top: `${style.positionY}%`,
      transform: "translate(-50%, -50%)",
      width: frame(FRAME_WIDTH - 2 * render.marginX),
      textAlign: "center",
      textWrap: "balance",
      pointerEvents: "none",
    },
    text,
  };
}
