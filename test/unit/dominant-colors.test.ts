import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { toHex } from "../../src/contrast.js";
import { dominantColors } from "../../src/dominant-colors.js";

type Pixel = [number, number, number];

/** A PNG whose pixel at (x, y) is `paint(x, y)`. */
async function png(width: number, height: number, paint: (x: number, y: number) => Pixel): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 3);
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

const summary = (colors: Awaited<ReturnType<typeof dominantColors>>) =>
  colors.map((c) => [toHex(c.color), Math.round(c.share * 100) / 100]);

// Deterministic noise in [-amount, amount], so tests don't depend on Math.random.
const noise = (x: number, y: number, amount: number) => (((x * 7919 + y * 104729) % 1000) / 1000) * 2 * amount - amount;
const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

describe("dominantColors", () => {
  it("finds the one color of a solid image", async () => {
    expect(summary(await dominantColors(await png(64, 64, () => [44, 95, 138])))).toEqual([["#2c5f8a", 1]]);
  });

  it("finds the colors of a split image and the share of each, most common first", async () => {
    const image = await png(200, 100, (x) => (x < 140 ? [255, 255, 255] : x < 180 ? [200, 30, 30] : [20, 20, 120]));
    expect(summary(await dominantColors(image))).toEqual([
      ["#ffffff", 0.7],
      ["#c81e1e", 0.2],
      ["#141478", 0.1],
    ]);
  });

  it("keeps a noisy area as one color instead of splitting it", async () => {
    const image = await png(128, 128, (x, y) => {
      const n = noise(x, y, 18);
      return y < 96 ? [clamp(90 + n), clamp(140 + n), clamp(200 + n)] : [30, 30, 30];
    });
    const colors = summary(await dominantColors(image));
    expect(colors).toHaveLength(2);
    expect(colors[0]?.[1]).toBe(0.75);
    expect(colors[1]).toEqual(["#1e1e1e", 0.25]);
  });

  it("looks only inside the region when one is given", async () => {
    const image = await png(100, 100, (_, y) => (y < 50 ? [0, 0, 0] : [250, 240, 230]));
    const colors = await dominantColors(image, { region: { left: 0, top: 60, width: 100, height: 40 } });
    expect(summary(colors)).toEqual([["#faf0e6", 1]]);
  });

  it("stops at maxColors", async () => {
    const image = await png(60, 10, (x) => {
      const v = Math.floor(x / 10) * 50;
      return [v, 255 - v, (v * 3) % 256];
    });
    const colors = await dominantColors(image, { maxColors: 3 });
    expect(colors).toHaveLength(3);
    expect(colors.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(1, 10);
  });

  it("gives the same answer every time", async () => {
    const image = await png(97, 61, (x, y) => [clamp(x * 2.6), clamp(y * 4), clamp(128 + noise(x, y, 60))]);
    expect(await dominantColors(image)).toEqual(await dominantColors(image));
  });

  it("treats transparent pixels as white", async () => {
    const image = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    expect(summary(await dominantColors(image))).toEqual([["#ffffff", 1]]);
  });

  it("handles a greyscale PNG", async () => {
    const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#808080" } })
      .greyscale()
      .png()
      .toBuffer();
    expect(summary(await dominantColors(image))).toEqual([["#808080", 1]]);
  });
});
