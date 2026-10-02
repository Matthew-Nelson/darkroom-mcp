import type { AspectRatio } from "./types.js";

const RATIOS: Record<AspectRatio, [number, number]> = {
  "1:1": [1, 1],
  "3:2": [3, 2],
  "2:3": [2, 3],
  "16:9": [16, 9],
  "9:16": [9, 16],
};

/**
 * Pixel size for an aspect ratio with the given short edge, with both sides
 * rounded to a multiple of `multiple` (diffusion models want multiples of 8 or 16).
 */
export function sizeForAspectRatio(
  aspectRatio: AspectRatio,
  shortEdge: number,
  multiple = 16,
): { width: number; height: number } {
  const [w, h] = RATIOS[aspectRatio];
  const round = (n: number) => Math.max(multiple, Math.round(n / multiple) * multiple);
  const scale = shortEdge / Math.min(w, h);
  return { width: round(w * scale), height: round(h * scale) };
}
