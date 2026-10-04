import { describe, expect, it } from "vitest";
import {
  AA_LARGE_TEXT,
  AA_NORMAL_TEXT,
  contrastRatio,
  displayRatio,
  isHexColor,
  parseHexColor,
  relativeLuminance,
  toHex,
} from "../../src/contrast.js";

const hex = parseHexColor;

describe("parseHexColor", () => {
  it.each([
    ["#ffffff", { r: 255, g: 255, b: 255 }],
    ["#000", { r: 0, g: 0, b: 0 }],
    ["1a2B3c", { r: 26, g: 43, b: 60 }],
    ["#f80", { r: 255, g: 136, b: 0 }],
    [" #767676 ", { r: 118, g: 118, b: 118 }],
  ])("%j", (input, rgb) => {
    expect(parseHexColor(input)).toEqual(rgb);
  });

  it.each(["", "#", "#12", "#1234", "#12345g", "white", "rgb(0,0,0)", "#ffffffff"])("rejects %j", (input) => {
    expect(isHexColor(input)).toBe(false);
    expect(() => parseHexColor(input)).toThrow(/Not a hex color/);
  });

  it("round-trips through toHex", () => {
    expect(toHex(hex("#1A2b3C"))).toBe("#1a2b3c");
    expect(toHex({ r: 254.6, g: 0.4, b: 16 })).toBe("#ff0010");
  });
});

describe("relativeLuminance", () => {
  it.each([
    ["#000000", 0],
    ["#ffffff", 1],
    ["#ff0000", 0.2126],
    ["#00ff00", 0.7152],
    ["#0000ff", 0.0722],
    // Both sides of the sRGB linear segment's threshold (0.04045 × 255 ≈ 10.3).
    ["#0a0a0a", 10 / 255 / 12.92],
    ["#808080", 0.2158605],
  ])("%s is %d", (color, luminance) => {
    expect(relativeLuminance(hex(color))).toBeCloseTo(luminance, 6);
  });
});

describe("contrastRatio", () => {
  // Rounded down to 2 decimals; cross-checked with an independent implementation. #767676 is the
  // lightest grey that passes AA for body text on white, #949494 the lightest for large text.
  it.each([
    ["#000000", "#ffffff", 21],
    ["#ffffff", "#ffffff", 1],
    ["#767676", "#ffffff", 4.54],
    ["#777777", "#ffffff", 4.47],
    ["#ff0000", "#ffffff", 3.99],
    ["#0000ff", "#ffffff", 8.59],
    ["#949494", "#ffffff", 3.03],
    ["#959595", "#ffffff", 2.99],
    ["#ffffff", "#2c5f8a", 6.75],
  ])("%s on %s is %d:1", (a, b, ratio) => {
    expect(displayRatio(contrastRatio(hex(a), hex(b)))).toBe(ratio);
  });

  it("is symmetric", () => {
    expect(contrastRatio(hex("#123456"), hex("#fedcba"))).toBe(contrastRatio(hex("#fedcba"), hex("#123456")));
  });

  it("puts the AA thresholds between the right neighbours", () => {
    expect(contrastRatio(hex("#767676"), hex("#fff"))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrastRatio(hex("#777777"), hex("#fff"))).toBeLessThan(AA_NORMAL_TEXT);
    expect(contrastRatio(hex("#949494"), hex("#fff"))).toBeGreaterThanOrEqual(AA_LARGE_TEXT);
    expect(contrastRatio(hex("#959595"), hex("#fff"))).toBeLessThan(AA_LARGE_TEXT);
  });
});

describe("displayRatio", () => {
  it("rounds down, so a failing ratio never displays as the threshold", () => {
    expect(displayRatio(4.4999)).toBe(4.49);
    expect(displayRatio(2.999)).toBe(2.99);
    expect(displayRatio(4.5)).toBe(4.5);
    expect(displayRatio(20.999999999999996)).toBe(21);
  });
});
