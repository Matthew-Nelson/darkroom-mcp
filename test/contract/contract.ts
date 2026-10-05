import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { PAID_PROVIDERS, PROVIDER_NAMES, type ProviderName } from "../../src/config.js";
import { ASPECT_RATIOS, QUALITIES, type GenerateRequest, type ImageProvider } from "../../src/providers/types.js";

// The shared contract every provider must pass. `cases` are the generate calls to
// make: every shape for offline providers, one cheap draft for real ones.

export interface ContractOptions {
  cases: GenerateRequest[];
  // Run with a reference image (one cheap draft for real providers), if the provider supports one.
  referenceCase?: GenerateRequest | undefined;
  timeoutMs?: number;
}

export function providerContract(label: string, make: () => ImageProvider | Promise<ImageProvider>, opts: ContractOptions) {
  const timeout = opts.timeoutMs ?? 20_000;

  describe(`provider contract: ${label}`, () => {
    it("declares a known name, its model, whether it costs money, and what it supports", async () => {
      const p = await make();
      expect(PROVIDER_NAMES).toContain(p.name);
      expect(p.model).toMatch(/\S/);
      expect(p.isPaid).toBe(PAID_PROVIDERS.has(p.name as ProviderName));
      expect(Object.keys(p.supports).sort()).toEqual(["negativePrompt", "referenceImage", "seed"]);
      for (const value of Object.values(p.supports)) expect(typeof value).toBe("boolean");
    });

    it("estimates cost for every shape: zero when free, above zero when paid", async () => {
      const p = await make();
      for (const aspectRatio of ASPECT_RATIOS) {
        for (const quality of QUALITIES) {
          const usd = p.estimateCostUsd({ prompt: "x", aspectRatio, quality });
          expect(Number.isFinite(usd)).toBe(true);
          if (p.isPaid) expect(usd).toBeGreaterThan(0);
          else expect(usd).toBe(0);
        }
      }
    });

    it("answers a health check with ok and an optional detail", async () => {
      const health = await (await make()).healthCheck();
      expect(health.ok).toBe(true);
      if (health.detail !== undefined) expect(typeof health.detail).toBe("string");
    });

    it("rejects an already-aborted request", async () => {
      const p = await make();
      await expect(p.generate(opts.cases[0] ?? { prompt: "x", aspectRatio: "1:1", quality: "draft" }, AbortSignal.abort())).rejects.toThrow();
    });

    const ref = opts.referenceCase;
    if (ref) {
      it(
        `generates a ${ref.aspectRatio} ${ref.quality} PNG from a reference image, if it can use one`,
        async () => {
          const p = await make();
          if (!p.supports.referenceImage) return;
          const withRef = { ...ref, referenceImage: await referenceImage() };
          expect(p.estimateCostUsd(withRef)).toBeGreaterThanOrEqual(p.estimateCostUsd(ref));
          const result = await p.generate(withRef, new AbortController().signal);
          const meta = await sharp(result.png).metadata();
          expect(meta.format).toBe("png");
          expect([meta.width, meta.height]).toEqual([result.width, result.height]);
          const [w, h] = ref.aspectRatio.split(":").map(Number) as [number, number];
          expect(Math.abs(result.width / result.height / (w / h) - 1)).toBeLessThan(0.05);
          if (!p.isPaid) expect(result.actualCostUsd ?? 0).toBe(0);
        },
        timeout,
      );
    }

    for (const req of opts.cases) {
      it(
        `generates a ${req.aspectRatio} ${req.quality} PNG that matches what it reports`,
        async () => {
          const p = await make();
          const result = await p.generate(req, new AbortController().signal);
          expect(result.model).toBe(p.model);

          const meta = await sharp(result.png).metadata();
          expect(meta.format).toBe("png");
          expect([meta.width, meta.height]).toEqual([result.width, result.height]);
          const [w, h] = req.aspectRatio.split(":").map(Number) as [number, number];
          expect(Math.abs(result.width / result.height / (w / h) - 1)).toBeLessThan(0.05);

          expect(result.model).toEqual(expect.any(String));
          expect(result.model).not.toBe("");
          if (!p.supports.seed) expect(result.seed).toBeNull();
          else if (req.seed !== undefined) expect(result.seed).toBe(req.seed);
          else expect(Number.isInteger(result.seed)).toBe(true);

          if (result.actualCostUsd !== undefined) {
            expect(Number.isFinite(result.actualCostUsd)).toBe(true);
            expect(result.actualCostUsd).toBeGreaterThanOrEqual(0);
          }
          if (!p.isPaid) expect(result.actualCostUsd ?? 0).toBe(0);
        },
        timeout,
      );
    }
  });
}

/** Every aspect ratio at both quality tiers, with a seed on half of them. */
export const ALL_SHAPES: GenerateRequest[] = ASPECT_RATIOS.flatMap((aspectRatio, i) =>
  QUALITIES.map((quality) => ({
    prompt: "a ceramic mug that says DARKROOM",
    aspectRatio,
    quality,
    ...(i % 2 === 0 && { seed: 1234 + i }),
  })),
);

export const ONE_DRAFT: GenerateRequest[] = [
  { prompt: "a ceramic mug on a wooden desk that says DARKROOM", aspectRatio: "1:1", quality: "draft", seed: 42 },
];

/** A simple scene to base an image on: sky, a yellow sun, and green ground, 768×512. */
export async function referenceImage(): Promise<{ png: Buffer; width: number; height: number }> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="512">
  <rect width="768" height="512" fill="#87ceeb"/><circle cx="384" cy="200" r="90" fill="#ffcc00"/>
  <rect y="340" width="768" height="172" fill="#2e8b57"/></svg>`;
  return { png: await sharp(Buffer.from(svg)).png().toBuffer(), width: 768, height: 512 };
}

export const REFERENCE_DRAFT: GenerateRequest = {
  prompt: "the same simple landscape, turned into a watercolor painting at sunset",
  aspectRatio: "3:2",
  quality: "draft",
};
