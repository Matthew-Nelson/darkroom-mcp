// WCAG 2.2 contrast: relative luminance, contrast ratio, and the AA thresholds for text.
// https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** AA minimums (success criterion 1.4.3). Large text is at least 18pt, or 14pt bold. */
export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;

const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(input: string): boolean {
  return HEX_COLOR.test(input);
}

/** Parses `#rgb` or `#rrggbb` (the `#` is optional). Throws on anything else. */
export function parseHexColor(input: string): Rgb {
  const digits = HEX_COLOR.exec(input.trim())?.[1];
  if (digits === undefined) throw new Error(`Not a hex color: ${input}. Use #rrggbb or #rgb.`);
  const full = digits.length === 3 ? digits.replace(/./g, "$&$&") : digits;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** Relative luminance of an sRGB color, 0 (black) to 1 (white). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Contrast ratio between two colors, 1 (none) to 21 (black on white), in either order. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Rounds a ratio down to 2 decimals for display. WCAG doesn't round, so 4.499 fails
 * 4.5:1; rounding down keeps the number shown consistent with the verdict.
 */
export function displayRatio(ratio: number): number {
  // The epsilon absorbs float error, so black on white shows 21 rather than 20.99.
  return Math.floor(ratio * 100 + 1e-9) / 100;
}
