import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { z } from "zod";
import {
  AA_LARGE_TEXT,
  AA_NORMAL_TEXT,
  contrastRatio,
  displayRatio,
  isHexColor,
  parseHexColor,
  toHex,
} from "../contrast.js";
import { dominantColors, type PixelBox } from "../dominant-colors.js";
import { log } from "../log.js";
import { StorageError, type Storage } from "../storage.js";
import { imageRefSchema } from "./save-alt-text.js";

/**
 * Colors covering at least this share of the checked area decide the verdict. With
 * at most 6 colors, the largest always covers at least 1/6, so there's always one.
 */
export const MAJOR_SHARE = 0.1;

const DESCRIPTION = `Check whether text in the given colors would be readable on top of a generated image, using WCAG 2.2 contrast.

It finds the image's dominant colors (or those in a region, such as where a headline will sit) and, for each text color, gives the contrast ratio against each one and an AA verdict: at least ${AA_NORMAL_TEXT}:1 for body text, ${AA_LARGE_TEXT}:1 for large text (18pt and up, or 14pt bold). A text color passes only if it passes against every color covering at least ${MAJOR_SHARE * 100}% of the checked area, so the verdict is the worst sizable background, not the average.

Use this when text will be placed over the image (a banner, poster, slide, or card). Pass a region when the text sits in one part of the image; the whole image is usually busier than the spot behind the text. It looks at color areas, not fine texture, so small text over a busy pattern can be hard to read even when this passes. It reads the file only and costs nothing.`;

const fraction = z.number().min(0).max(1);

const regionSchema = z
  .object({
    x: fraction.describe("Left edge, as a fraction of the image's width"),
    y: fraction.describe("Top edge, as a fraction of the image's height"),
    width: fraction.positive(),
    height: fraction.positive(),
  })
  .refine((r) => r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9, {
    message: "The region must fit inside the image: x + width and y + height can be at most 1.",
  })
  .describe(
    "Where the text will sit, as fractions of the image from its top-left corner; e.g. the bottom third is {x: 0, y: 0.667, width: 1, height: 0.333}. Leave out to check the whole image.",
  );

const inputSchema = {
  image: imageRefSchema,
  text_colors: z
    .array(z.string().trim().refine(isHexColor, { message: "Use a hex color: #rrggbb or #rgb." }))
    .min(1)
    .max(8)
    .describe('Text colors to check, as hex, e.g. ["#ffffff", "#1a1a1a"]'),
  region: regionSchema.optional(),
};

const ratioSchema = z.object({ color: z.string(), share: z.number(), ratio: z.number() });

const outputSchema = {
  path: z.string().describe("Absolute path of the PNG"),
  region: z
    .object({ left: z.number().int(), top: z.number().int(), width: z.number().int(), height: z.number().int() })
    .describe("The area checked, in pixels (the whole image when no region was given)"),
  dominant_colors: z
    .array(z.object({ color: z.string(), share: z.number().describe("Fraction of the checked area, 0-1") }))
    .describe("Most common first"),
  results: z.array(
    z.object({
      text_color: z.string(),
      worst_ratio: z.number().describe(`Lowest ratio against a color covering at least ${MAJOR_SHARE * 100}% of the area`),
      worst_against: z.string(),
      body_text_aa: z.boolean().describe(`worst_ratio is at least ${AA_NORMAL_TEXT}:1`),
      large_text_aa: z.boolean().describe(`worst_ratio is at least ${AA_LARGE_TEXT}:1`),
      ratios: z.array(ratioSchema).describe("Against every dominant color, in the same order"),
    }),
  ),
};

type Output = { [K in keyof typeof outputSchema]: z.infer<(typeof outputSchema)[K]> };
type Region = z.infer<typeof regionSchema>;

/** Contrast of each text color against an image's dominant colors, with AA verdicts. */
export async function checkContrast(pngPath: string, textColors: string[], region?: Region): Promise<Output> {
  const { width, height } = await sharp(pngPath).metadata();
  const box = toPixels(region, width, height);
  const colors = await dominantColors(pngPath, { region: box });
  const results = textColors.map((input) => {
    const text = parseHexColor(input);
    const ratios = colors.map((c) => ({ color: toHex(c.color), share: c.share, ratio: contrastRatio(text, c.color) }));
    const worst = ratios
      .filter((r) => r.share >= MAJOR_SHARE)
      .reduce((a, b) => (b.ratio < a.ratio ? b : a));
    return {
      text_color: toHex(text),
      worst_ratio: displayRatio(worst.ratio),
      worst_against: worst.color,
      body_text_aa: worst.ratio >= AA_NORMAL_TEXT,
      large_text_aa: worst.ratio >= AA_LARGE_TEXT,
      ratios: ratios.map((r) => ({ ...r, share: roundShare(r.share), ratio: displayRatio(r.ratio) })),
    };
  });
  return {
    path: pngPath,
    region: box,
    dominant_colors: colors.map((c) => ({ color: toHex(c.color), share: roundShare(c.share) })),
    results,
  };
}

/** Turns a fractional region into a pixel box at least 1px across, inside the image. */
export function toPixels(region: Region | undefined, width: number, height: number): PixelBox {
  if (!region) return { left: 0, top: 0, width, height };
  const left = Math.min(width - 1, Math.round(region.x * width));
  const top = Math.min(height - 1, Math.round(region.y * height));
  return {
    left,
    top,
    width: Math.max(1, Math.min(width - left, Math.round(region.width * width))),
    height: Math.max(1, Math.min(height - top, Math.round(region.height * height))),
  };
}

function roundShare(share: number): number {
  return Math.round(share * 1000) / 1000;
}

export function registerCheckContrast(server: McpServer, deps: { storage: Storage }): void {
  server.registerTool(
    "check_contrast",
    {
      title: "Check text contrast",
      description: DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const image = await deps.storage.find(args.image);
        const output = await checkContrast(image.pngPath, args.text_colors, args.region);
        return {
          content: [{ type: "text", text: `${summarize(output, args.region !== undefined)}\n\n${JSON.stringify(output)}` }],
          structuredContent: output,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!(err instanceof StorageError)) log("warn", "check_contrast failed", { error: reason });
        return { isError: true, content: [{ type: "text", text: `Couldn't check contrast: ${reason}` }] };
      }
    },
  );
}

function summarize(o: Output, hasRegion: boolean): string {
  const r = o.region;
  const area = hasRegion ? `the region at ${r.left},${r.top} (${r.width}×${r.height}px) of` : "all of";
  const percent = (share: number) => `${Math.round(share * 100)}%`;
  const lines = [
    `Checked ${area} ${o.path}.`,
    `Dominant colors: ${o.dominant_colors.map((c) => `${c.color} ${percent(c.share)}`).join(", ")}.`,
  ];
  for (const t of o.results) {
    const verdict = (ok: boolean, needs: number) => `${ok ? "passes" : "fails"} AA (needs ${needs}:1)`;
    const against = o.dominant_colors.find((c) => c.color === t.worst_against);
    lines.push(
      `${t.text_color}: worst ${t.worst_ratio}:1, against ${t.worst_against}${against ? ` (${percent(against.share)})` : ""}. ` +
        `Body text ${verdict(t.body_text_aa, AA_NORMAL_TEXT)}; large text ${verdict(t.large_text_aa, AA_LARGE_TEXT)}.`,
    );
  }
  return lines.join("\n");
}
