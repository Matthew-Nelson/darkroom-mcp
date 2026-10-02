import { randomInt } from "node:crypto";
import sharp from "sharp";
import { sizeForQuality } from "./sizes.js";
import type { GenerateRequest, GenerateResult, ImageProvider, ProgressListener } from "./types.js";

const MODEL = "mock-placeholder-v1";

/**
 * Draws the prompt and seed on a background whose color comes from the seed.
 * No network, no GPU, no cost: for tests, CI, and demos.
 */
export function createMockProvider(): ImageProvider {
  return {
    name: "mock",
    isPaid: false,
    supports: { negativePrompt: false, seed: true },
    estimateCostUsd: () => 0,
    healthCheck: () => Promise.resolve({ ok: true }),
    async generate(req: GenerateRequest, signal: AbortSignal, onProgress?: ProgressListener): Promise<GenerateResult> {
      signal.throwIfAborted();
      onProgress?.({ message: "Drawing placeholder" });
      const seed = req.seed ?? randomInt(0, 2 ** 32);
      const { width, height } = sizeForQuality(req.aspectRatio, req.quality);
      const svg = placeholderSvg({ width, height, seed, prompt: req.prompt });
      const png = await sharp(Buffer.from(svg)).png().toBuffer();
      signal.throwIfAborted();
      return { png, model: MODEL, width, height, seed, actualCostUsd: 0 };
    },
  };
}

function placeholderSvg(o: { width: number; height: number; seed: number; prompt: string }): string {
  const { width, height, seed } = o;
  const fontSize = Math.round(Math.min(width, height) / 20);
  const margin = Math.round(fontSize * 1.5);
  const lineHeight = Math.round(fontSize * 1.3);
  // Rough average glyph width for a sans-serif face; wrapping only needs to be close.
  const charsPerLine = Math.max(8, Math.floor((width - 2 * margin) / (fontSize * 0.55)));
  const maxLines = Math.max(1, Math.floor((height - 3 * margin - lineHeight) / lineHeight));
  const lines = wrap(o.prompt, charsPerLine, maxLines);
  const footer = `mock · seed ${seed} · ${width}×${height}`;

  const text = lines
    .map((line, i) => `<text x="${margin}" y="${margin + fontSize + i * lineHeight}">${escapeXml(line)}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="${seedColor(seed)}"/>
  <g font-family="Helvetica, Arial, DejaVu Sans, sans-serif" font-size="${fontSize}" fill="#ffffff">${text}</g>
  <text x="${margin}" y="${height - margin}" font-family="Menlo, DejaVu Sans Mono, monospace"
    font-size="${Math.round(fontSize * 0.75)}" fill="#ffffff" fill-opacity="0.75">${escapeXml(footer)}</text>
</svg>`;
}

/** Word-wraps to at most `maxLines`, ending with an ellipsis if text was cut. */
export function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const raw of words) {
    // Break words longer than a line so one long token can't overflow the image.
    for (let word = raw; word.length > 0; word = word.slice(width)) {
      const piece = word.slice(0, width);
      if (current === "") current = piece;
      else if (current.length + 1 + piece.length <= width) current += ` ${piece}`;
      else {
        lines.push(current);
        current = piece;
      }
    }
  }
  if (current !== "") lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? "";
  kept[maxLines - 1] = `${last.slice(0, Math.max(0, width - 1))}…`;
  return kept;
}

/** Spreads consecutive seeds around the color wheel (golden angle) at a fixed dark tone. */
export function seedColor(seed: number): string {
  const hue = (seed * 137.508) % 360;
  return hslToHex(hue, 0.45, 0.32);
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
