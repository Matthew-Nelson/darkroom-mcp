import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createMockProvider, seedColor, wrap } from "../../src/providers/mock.js";
import { sizeForQuality } from "../../src/providers/sizes.js";
import type { AspectRatio, GenerateRequest, Quality } from "../../src/providers/types.js";

const signal = new AbortController().signal;
const request = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  prompt: "a ceramic mug that says DARKROOM",
  aspectRatio: "1:1",
  quality: "draft",
  ...over,
});

describe("sizeForQuality", () => {
  // Sized by pixel count (~0.26MP draft, ~1MP final), so wide images don't cost more than square ones.
  it.each<[AspectRatio, Quality, [number, number]]>([
    ["1:1", "draft", [512, 512]],
    ["3:2", "draft", [624, 416]],
    ["2:3", "draft", [416, 624]],
    ["16:9", "draft", [688, 384]],
    ["9:16", "draft", [384, 688]],
    ["1:1", "final", [1024, 1024]],
    ["3:2", "final", [1248, 832]],
    ["16:9", "final", [1360, 768]],
    ["9:16", "final", [768, 1360]],
  ])("%s %s -> %j", (ratio, quality, expected) => {
    const { width, height } = sizeForQuality(ratio, quality);
    expect([width, height]).toEqual(expected);
    expect(width % 16).toBe(0);
    expect(height % 16).toBe(0);
    const target = quality === "draft" ? 512 * 512 : 1024 * 1024;
    expect(Math.abs(width * height - target) / target).toBeLessThan(0.03);
  });
});

describe("mock provider", () => {
  const mock = createMockProvider();

  it("is free, healthy, and needs no network", async () => {
    expect(mock.isPaid).toBe(false);
    expect(mock.estimateCostUsd(request())).toBe(0);
    expect(await mock.healthCheck()).toEqual({ ok: true });
  });

  // Text rendering depends on system fonts, so assert on format and size, never bytes.
  it.each<[AspectRatio, Quality, number, number]>([
    ["1:1", "draft", 512, 512],
    ["3:2", "draft", 624, 416],
    ["2:3", "draft", 416, 624],
    ["16:9", "draft", 688, 384],
    ["9:16", "draft", 384, 688],
    ["1:1", "final", 1024, 1024],
    ["9:16", "final", 768, 1360],
  ])("renders %s %s as a %dx%d PNG", async (aspectRatio, quality, width, height) => {
    const result = await mock.generate(request({ aspectRatio, quality }), signal);
    const meta = await sharp(result.png).metadata();
    expect(meta.format).toBe("png");
    expect([meta.width, meta.height]).toEqual([width, height]);
    expect([result.width, result.height]).toEqual([width, height]);
    expect(result.model).toBe("mock-placeholder-v1");
    expect(result.actualCostUsd).toBe(0); // free, so the cost is known, not estimated
  });

  it("echoes a given seed", async () => {
    expect((await mock.generate(request({ seed: 42 }), signal)).seed).toBe(42);
  });

  it("picks a random seed when none is given", async () => {
    const { seed } = await mock.generate(request(), signal);
    expect(Number.isInteger(seed)).toBe(true);
  });

  it("survives prompts with markup and very long text", async () => {
    const prompt = `<svg onload="x"> & 'quotes' ${"word ".repeat(800)}`;
    const result = await mock.generate(request({ prompt }), signal);
    expect((await sharp(result.png).metadata()).format).toBe("png");
  });

  it("rejects when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(mock.generate(request(), controller.signal)).rejects.toThrow("cancelled");
  });
});

describe("wrap", () => {
  it("wraps on word boundaries", () => {
    expect(wrap("the quick brown fox jumps", 10, 5)).toEqual(["the quick", "brown fox", "jumps"]);
  });

  it("breaks words longer than a line", () => {
    expect(wrap("abcdefghijkl", 5, 5)).toEqual(["abcde", "fghij", "kl"]);
  });

  it("ends with an ellipsis when text is cut", () => {
    expect(wrap("one two three four five six", 9, 2)).toEqual(["one two", "three…"]);
  });
});

describe("seedColor", () => {
  it("is deterministic and differs between neighboring seeds", () => {
    expect(seedColor(42)).toBe(seedColor(42));
    expect(seedColor(42)).not.toBe(seedColor(43));
    expect(seedColor(42)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("mock provider with a reference image", () => {
  const mock = createMockProvider();
  const half = async (left: string, right: string) => {
    const side = { width: 400, height: 400, channels: 3 as const };
    const png = await sharp({ create: { ...side, width: 800, background: left } })
      .composite([{ input: await sharp({ create: { ...side, background: right } }).png().toBuffer(), left: 400, top: 0 }])
      .png()
      .toBuffer();
    return { png, width: 800, height: 400 };
  };

  it("says it can use one", () => {
    expect(mock.supports.referenceImage).toBe(true);
  });

  it("draws the reference, cropped to the requested shape, under the text", async () => {
    // Red left half, blue right half; a square crop keeps the middle, so both show.
    const referenceImage = await half("#ff0000", "#0000ff");
    const result = await mock.generate(request({ referenceImage }), signal);
    expect([result.width, result.height]).toEqual([512, 512]);
    const { data } = await sharp(result.png).resize(2, 2, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
    const [r1, , b1] = [...data.subarray(0, 3)] as [number, number, number]; // top-left
    const [r2, , b2] = [...data.subarray(3, 6)] as [number, number, number]; // top-right
    expect(r1).toBeGreaterThan(b1); // still reddish under the darkening
    expect(b2).toBeGreaterThan(r2);
  });

  it("flattens a transparent reference onto its seed color", async () => {
    const clear = { r: 0, g: 0, b: 0, alpha: 0 };
    const png = await sharp({ create: { width: 200, height: 200, channels: 4, background: clear } }).png().toBuffer();
    const result = await mock.generate(request({ referenceImage: { png, width: 200, height: 200 } }), signal);
    const meta = await sharp(result.png).metadata();
    expect([meta.format, meta.width, meta.hasAlpha]).toEqual(["png", 512, false]);
  });
});
