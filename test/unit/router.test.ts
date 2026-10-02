import { describe, expect, it, vi } from "vitest";
import { loadConfig, type ProviderName } from "../../src/config.js";
import type { GenerateRequest, ImageProvider } from "../../src/providers/types.js";
import { NoProviderError, Router } from "../../src/router.js";

const req: GenerateRequest = { prompt: "a mug", aspectRatio: "1:1", quality: "draft" };
const signal = new AbortController().signal;

function fakeProvider(name: string, over: Partial<ImageProvider> = {}): ImageProvider {
  return {
    name,
    isPaid: false,
    supports: { negativePrompt: false, seed: true },
    estimateCostUsd: () => 0,
    healthCheck: () => Promise.resolve({ ok: true }),
    generate: vi.fn(() =>
      Promise.resolve({ png: Buffer.from(name), model: `${name}-model`, width: 1, height: 1, seed: 1 }),
    ),
    ...over,
  };
}

function router(order: string, providers: Partial<Record<ProviderName, ImageProvider>>): Router {
  const map = new Map(Object.entries(providers) as [ProviderName, ImageProvider][]);
  return new Router(loadConfig({ DARKROOM_PROVIDER_ORDER: order }), map);
}

describe("Router (M0)", () => {
  it("uses the first provider in the order", async () => {
    const routed = await router("mock", { mock: fakeProvider("mock") }).generate(req, { signal });
    expect(routed.provider.name).toBe("mock");
    expect(routed.skipped).toEqual([]);
  });

  it("skips providers that aren't implemented yet and says why", async () => {
    const routed = await router("comfyui,mock", { mock: fakeProvider("mock") }).generate(req, { signal });
    expect(routed.provider.name).toBe("mock");
    expect(routed.skipped).toEqual([{ provider: "comfyui", reason: "not available in this version of Darkroom yet" }]);
  });

  it("skips unhealthy providers and reports the health detail", async () => {
    const sick = fakeProvider("comfyui", { healthCheck: () => Promise.resolve({ ok: false, detail: "connection refused" }) });
    const routed = await router("comfyui,mock", { comfyui: sick, mock: fakeProvider("mock") }).generate(req, { signal });
    expect(routed.provider.name).toBe("mock");
    expect(routed.skipped).toEqual([{ provider: "comfyui", reason: "unhealthy: connection refused" }]);
    expect(sick.generate).not.toHaveBeenCalled();
  });

  it("treats a throwing health check as unhealthy", async () => {
    const broken = fakeProvider("comfyui", { healthCheck: () => Promise.reject(new Error("boom")) });
    const routed = await router("comfyui,mock", { comfyui: broken, mock: fakeProvider("mock") }).generate(req, {
      signal,
    });
    expect(routed.skipped).toEqual([{ provider: "comfyui", reason: "unhealthy: boom" }]);
  });

  it("never calls a paid provider before the ledger exists", async () => {
    const paid = fakeProvider("openai", { isPaid: true });
    const r = router("openai", { openai: paid });
    await expect(r.generate(req, { signal })).rejects.toThrow(NoProviderError);
    await expect(r.generate(req, { provider: "openai", signal })).rejects.toThrow(/paid providers/);
    expect(paid.generate).not.toHaveBeenCalled();
  });

  it("fails clearly with the default order, since comfyui isn't implemented yet", async () => {
    const err = await router("comfyui", { mock: fakeProvider("mock") })
      .generate(req, { signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoProviderError);
    expect((err as Error).message).toBe(
      "No image provider could take this request (comfyui: not available in this version of Darkroom yet).",
    );
  });

  it("uses only the explicit provider, with no fallback", async () => {
    const mock = fakeProvider("mock");
    const r = router("comfyui,mock", { mock });
    await expect(r.generate(req, { provider: "comfyui", signal })).rejects.toThrow(NoProviderError);
    expect(mock.generate).not.toHaveBeenCalled();
    expect((await r.generate(req, { provider: "mock", signal })).skipped).toEqual([]);
  });

  it("rejects an explicit provider that isn't in the order", async () => {
    const r = router("mock", { mock: fakeProvider("mock") });
    await expect(r.generate(req, { provider: "openai", signal })).rejects.toThrow(
      'Provider "openai" is not enabled. Enabled providers: mock. To enable it, add it to DARKROOM_PROVIDER_ORDER.',
    );
  });

  it("passes the abort signal through to the provider", async () => {
    const mock = fakeProvider("mock");
    const controller = new AbortController();
    await router("mock", { mock }).generate(req, { signal: controller.signal });
    expect(mock.generate).toHaveBeenCalledWith(req, controller.signal, undefined);
  });
});
