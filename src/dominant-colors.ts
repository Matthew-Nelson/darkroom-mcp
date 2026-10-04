import sharp from "sharp";
import type { Rgb } from "./contrast.js";

/** Long edge the image is shrunk to before counting colors: plenty for shares, and fast. */
const ANALYSIS_EDGE = 256;
/** Bits kept per channel when bucketing pixels (32 levels each). */
const BUCKET_BITS = 5;
const MAX_ITERATIONS = 20;
/**
 * Clusters whose centers end up closer than this (Euclidean, 0–255 RGB) are merged,
 * so one noisy or gently shaded area isn't split into several small "colors".
 */
const MERGE_DISTANCE = 40;

export interface ColorShare {
  color: Rgb;
  /** Fraction of the analysed pixels, 0–1. */
  share: number;
}

export interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Point extends Rgb {
  weight: number;
}

/**
 * The main colors of an image (or a box within it), most common first, with the
 * share of pixels each covers. Shares add up to 1. Pixels are bucketed by color,
 * the buckets are grouped with weighted k-means, and near-identical groups merged.
 */
export async function dominantColors(
  input: string | Buffer,
  opts: { region?: PixelBox | undefined; maxColors?: number } = {},
): Promise<ColorShare[]> {
  let image = sharp(input);
  if (opts.region) image = image.extract(opts.region);
  const { data, info } = await image
    .resize(ANALYSIS_EDGE, ANALYSIS_EDGE, { fit: "inside", withoutEnlargement: true })
    // Transparent pixels count as white, matching the previews Claude sees.
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`Expected 3 color channels, got ${info.channels}.`);

  const points = bucket(data);
  const clusters = merge(kMeans(points, Math.min(opts.maxColors ?? 6, points.length)));
  const total = clusters.reduce((sum, c) => sum + c.weight, 0);
  return clusters
    .map(({ weight, ...color }) => ({ color: roundRgb(color), share: weight / total }))
    .sort((a, b) => b.share - a.share);
}

/** Groups pixels into color buckets, each represented by the mean of its pixels. */
function bucket(data: Buffer): Point[] {
  const shift = 8 - BUCKET_BITS;
  const size = 1 << (3 * BUCKET_BITS);
  const count = new Uint32Array(size);
  const sums = new Float64Array(size * 3);
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const key = ((r >> shift) << (2 * BUCKET_BITS)) | ((g >> shift) << BUCKET_BITS) | (b >> shift);
    count[key] = (count[key] ?? 0) + 1;
    sums[key * 3] = (sums[key * 3] ?? 0) + r;
    sums[key * 3 + 1] = (sums[key * 3 + 1] ?? 0) + g;
    sums[key * 3 + 2] = (sums[key * 3 + 2] ?? 0) + b;
  }
  const points: Point[] = [];
  count.forEach((n, key) => {
    if (n === 0) return;
    points.push({
      r: (sums[key * 3] ?? 0) / n,
      g: (sums[key * 3 + 1] ?? 0) / n,
      b: (sums[key * 3 + 2] ?? 0) / n,
      weight: n,
    });
  });
  return points;
}

/**
 * Weighted k-means. Seeded deterministically: the heaviest bucket first, then each
 * time the bucket with the most weight far from every center so far, so the same
 * image always gives the same colors.
 */
function kMeans(points: Point[], k: number): Point[] {
  if (k === 0) return [];
  const heaviest = points.reduce((a, b) => (b.weight > a.weight ? b : a));
  const centers: Rgb[] = [{ ...heaviest }];
  const nearest = points.map((p) => distance2(p, heaviest));
  while (centers.length < k) {
    let best = -1;
    let bestScore = 0;
    points.forEach((p, i) => {
      const score = p.weight * (nearest[i] ?? 0);
      if (score > bestScore) [best, bestScore] = [i, score];
    });
    const next = points[best];
    if (!next) break; // every bucket already is a center
    centers.push({ ...next });
    points.forEach((p, i) => (nearest[i] = Math.min(nearest[i] ?? Infinity, distance2(p, next))));
  }

  let assignment = new Int32Array(points.length).fill(-1);
  let clusters: Point[] = [];
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const next = new Int32Array(points.length);
    points.forEach((p, i) => (next[i] = closest(p, centers)));
    clusters = centers.map(() => ({ r: 0, g: 0, b: 0, weight: 0 }));
    points.forEach((p, i) => {
      const c = clusters[next[i] ?? 0];
      if (!c) return;
      c.r += p.r * p.weight;
      c.g += p.g * p.weight;
      c.b += p.b * p.weight;
      c.weight += p.weight;
    });
    clusters.forEach((c, i) => {
      if (c.weight === 0) return;
      centers[i] = { r: c.r / c.weight, g: c.g / c.weight, b: c.b / c.weight };
    });
    const stable = next.every((a, i) => a === assignment[i]);
    assignment = next;
    if (stable) break;
  }
  return clusters.flatMap((c, i) => (c.weight === 0 ? [] : [{ ...(centers[i] as Rgb), weight: c.weight }]));
}

/** Repeatedly merges the closest two clusters while they're within MERGE_DISTANCE. */
function merge(clusters: Point[]): Point[] {
  const out = [...clusters];
  for (;;) {
    let pair: [number, number] | undefined;
    let best = MERGE_DISTANCE ** 2;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const d = distance2(out[i] as Point, out[j] as Point);
        if (d < best) [pair, best] = [[i, j], d];
      }
    }
    if (!pair) return out;
    const [a, b] = [out[pair[0]] as Point, out[pair[1]] as Point];
    const weight = a.weight + b.weight;
    out[pair[0]] = {
      r: (a.r * a.weight + b.r * b.weight) / weight,
      g: (a.g * a.weight + b.g * b.weight) / weight,
      b: (a.b * a.weight + b.b * b.weight) / weight,
      weight,
    };
    out.splice(pair[1], 1);
  }
}

function closest(p: Rgb, centers: Rgb[]): number {
  let best = 0;
  let bestDistance = Infinity;
  centers.forEach((c, i) => {
    const d = distance2(p, c);
    if (d < bestDistance) [best, bestDistance] = [i, d];
  });
  return best;
}

function distance2(a: Rgb, b: Rgb): number {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

function roundRgb({ r, g, b }: Rgb): Rgb {
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}
