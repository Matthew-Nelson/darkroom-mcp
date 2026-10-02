import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createMockProvider, seedColor, wrap } from "../../src/providers/mock.js";
import { sizeForAspectRatio } from "../../src/providers/sizes.js";
import type { AspectRatio, GenerateRequest, Quality } from "../../src/providers/types.js";

const signal = new AbortController().signal;
const request = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  prompt: "a ceramic mug that says DARKROOM",
  aspectRatio: "1:1",
  quality: "draft",
  ...over,
});

describe("sizeForAspectRatio", () => {
  it.each<[AspectRatio, number, [number, number]]>([
    ["1:1", 512, [512, 512]],
    ["3:2", 512, [768, 512]],
    ["2:3", 512, [512, 768]],
    ["16:9", 512, [912, 512]],
    ["9:16", 512, [512, 912]],
    ["1:1", 1024, [1024, 1024]],
    ["3:2", 1024, [1536, 1024]],
    ["16:9", 1024, [1824, 1024]],
  ])("%s at short edge %d -> %j", (ratio, shortEdge, expected) => {
    const { width, height } = sizeForAspectRatio(ratio, shortEdge);
    expect([width, height]).toEqual(expected);
    expect(width % 16).toBe(0);
    expect(height % 16).toBe(0);
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
    ["3:2", "draft", 768, 512],
    ["2:3", "draft", 512, 768],
    ["16:9", "draft", 912, 512],
    ["9:16", "draft", 512, 912],
    ["1:1", "final", 1024, 1024],
    ["9:16", "final", 1024, 1824],
  ])("renders %s %s as a %dx%d PNG", async (aspectRatio, quality, width, height) => {
    const result = await mock.generate(request({ aspectRatio, quality }), signal);
    const meta = await sharp(result.png).metadata();
    expect(meta.format).toBe("png");
    expect([meta.width, meta.height]).toEqual([width, height]);
    expect([result.width, result.height]).toEqual([width, height]);
    expect(result.model).toBe("mock-placeholder-v1");
    expect(result.actualCostUsd).toBeUndefined();
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
