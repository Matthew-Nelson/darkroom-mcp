import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkContrast, toPixels } from "../../src/tools/check-contrast.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "darkroom-contrast-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes a PNG of horizontal bands, top to bottom: [hex, rows] pairs. */
async function bands(...rows: [string, number][]): Promise<string> {
  const height = rows.reduce((sum, [, n]) => sum + n, 0);
  const path = join(dir, `bands-${rows.map(([c]) => c.slice(1)).join("-")}.png`);
  let top = 0;
  const layers = rows.map(([color, n]) => {
    const layer = { input: { create: { width: 100, height: n, channels: 3 as const, background: color } }, top, left: 0 };
    top += n;
    return layer;
  });
  await sharp({ create: { width: 100, height, channels: 3, background: "#000000" } }).composite(layers).png().toFile(path);
  return path;
}

describe("checkContrast", () => {
  it("gives each text color's ratio against every dominant color, and AA verdicts", async () => {
    const path = await bands(["#ffffff", 100]);
    const out = await checkContrast(path, ["#767676", "#777777", "#949494", "#000"]);
    expect(out.region).toEqual({ left: 0, top: 0, width: 100, height: 100 });
    expect(out.dominant_colors).toEqual([{ color: "#ffffff", share: 1 }]);
    expect(out.results.map((r) => [r.text_color, r.worst_ratio, r.body_text_aa, r.large_text_aa])).toEqual([
      ["#767676", 4.54, true, true],
      ["#777777", 4.47, false, true],
      ["#949494", 3.03, false, true],
      ["#000000", 21, true, true],
    ]);
  });

  it("judges by the worst color covering at least 10% of the area", async () => {
    // White text: fine on the navy (85%), poor on the pale band (15%).
    const path = await bands(["#1b2a4a", 85], ["#d8dde6", 15]);
    const [white] = (await checkContrast(path, ["#fff"])).results;
    expect(white).toMatchObject({ worst_against: "#d8dde6", body_text_aa: false, large_text_aa: false });
    expect(white?.worst_ratio).toBeLessThan(1.5);
    expect(white?.ratios.map((r) => [r.color, r.share])).toEqual([
      ["#1b2a4a", 0.85],
      ["#d8dde6", 0.15],
    ]);
  });

  it("ignores a color covering less than 10%", async () => {
    const path = await bands(["#1b2a4a", 95], ["#d8dde6", 5]);
    const [white] = (await checkContrast(path, ["#fff"])).results;
    expect(white).toMatchObject({ worst_against: "#1b2a4a", body_text_aa: true, large_text_aa: true });
    // Still reported, so the caller can see what was left out.
    expect(white?.ratios).toHaveLength(2);
  });

  it("adds up colors under 10% that fail, so splitting a dark area into pieces can't hide it", async () => {
    // Like pines in the corner of a sky: two dark colors, 8% and 5%, each under the cutoff, 13% together.
    const path = await bands(["#dcd0cb", 87], ["#1f211a", 8], ["#5a5b61", 5]);
    const out = await checkContrast(path, ["#111111"]);
    expect(out.dominant_colors.map((c) => [c.color, c.share])).toEqual([
      ["#dcd0cb", 0.87],
      ["#1f211a", 0.08],
      ["#5a5b61", 0.05],
    ]);
    // Sorted by ratio, the 10% mark falls inside the second dark color.
    expect(out.results[0]).toMatchObject({ worst_against: "#5a5b61", body_text_aa: false, large_text_aa: false });
  });

  it("checks only the region when one is given", async () => {
    const path = await bands(["#d8dde6", 50], ["#1b2a4a", 50]);
    const whole = await checkContrast(path, ["#fff"]);
    expect(whole.results[0]?.body_text_aa).toBe(false);
    const bottom = await checkContrast(path, ["#fff"], { x: 0, y: 0.5, width: 1, height: 0.5 });
    expect(bottom.region).toEqual({ left: 0, top: 50, width: 100, height: 50 });
    expect(bottom.dominant_colors).toEqual([{ color: "#1b2a4a", share: 1 }]);
    expect(bottom.results[0]?.body_text_aa).toBe(true);
  });
});

describe("toPixels", () => {
  it("is the whole image without a region", () => {
    expect(toPixels(undefined, 1024, 768)).toEqual({ left: 0, top: 0, width: 1024, height: 768 });
  });

  it("rounds fractions to pixels", () => {
    expect(toPixels({ x: 0, y: 0.667, width: 1, height: 0.333 }, 1024, 768)).toEqual({
      left: 0,
      top: 512,
      width: 1024,
      height: 256,
    });
  });

  it("keeps the box inside the image and at least 1px across", () => {
    expect(toPixels({ x: 1, y: 1, width: 0.0001, height: 0.0001 }, 100, 50)).toEqual({ left: 99, top: 49, width: 1, height: 1 });
    expect(toPixels({ x: 0.5, y: 0, width: 0.5000000001, height: 1 }, 101, 50)).toEqual({ left: 51, top: 0, width: 50, height: 50 });
  });
});
