import type { AspectRatio, Quality } from "./types.js";

const RATIOS: Record<AspectRatio, [number, number]> = {
  "1:1": [1, 1],
  "3:2": [3, 2],
  "2:3": [2, 3],
  "16:9": [16, 9],
  "9:16": [9, 16],
};

// Tiers are a pixel budget, not a short edge: diffusion models are trained near
// 1MP, and time and memory scale with pixel count, so a 16:9 "final" should cost
// about what a square one does.
export const QUALITY_PIXELS: Record<Quality, number> = {
  draft: 512 * 512,
  final: 1024 * 1024,
};

/**
 * Pixel size for an aspect ratio holding about `pixels` pixels, with both sides
 * rounded to a multiple of `multiple` (diffusion models want multiples of 8 or 16).
 */
export function sizeForArea(
  aspectRatio: AspectRatio,
  pixels: number,
  multiple = 16,
): { width: number; height: number } {
  const [w, h] = RATIOS[aspectRatio];
  const round = (n: number) => Math.max(multiple, Math.round(n / multiple) * multiple);
  return { width: round(Math.sqrt((pixels * w) / h)), height: round(Math.sqrt((pixels * h) / w)) };
}

export function sizeForQuality(aspectRatio: AspectRatio, quality: Quality, multiple = 16): { width: number; height: number } {
  return sizeForArea(aspectRatio, QUALITY_PIXELS[quality], multiple);
}
