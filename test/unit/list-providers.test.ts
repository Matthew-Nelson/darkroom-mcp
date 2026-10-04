import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type ProviderName } from "../../src/config.js";
import { Ledger, LEDGER_FILENAME } from "../../src/ledger.js";
import type { ImageProvider } from "../../src/providers/types.js";
import { Router } from "../../src/router.js";
import { providerStatus } from "../../src/tools/list-providers.js";

let dir: string;
let ledger: Ledger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "darkroom-list-providers-"));
  ledger = Ledger.inDir(dir, { now: () => new Date("2026-10-02T12:00:00Z") });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeProvider(name: string, over: Partial<ImageProvider> = {}): ImageProvider {
  return {
    name,
    model: `${name}-model`,
    isPaid: false,
    supports: { negativePrompt: false, seed: true, referenceImage: false },
    estimateCostUsd: () => 0,
    healthCheck: () => Promise.resolve({ ok: true }),
    generate: vi.fn(() => Promise.reject(new Error("not used"))),
    ...over,
  };
}

const openai = (over: Partial<ImageProvider> = {}) =>
  fakeProvider("openai", { isPaid: true, estimateCostUsd: (req) => (req.quality === "draft" ? 0.007 : 0.021), ...over });

function status(
  env: Record<string, string>,
  providers: Partial<Record<ProviderName, ImageProvider>>,
  implemented: ProviderName[] = ["mock", "comfyui", "openai"],
) {
  const config = loadConfig(env);
  const router = new Router(config, new Map(Object.entries(providers) as [ProviderName, ImageProvider][]), ledger);
  return providerStatus({ config, router, ledger, implemented: new Set(implemented) });
}

describe("providerStatus", () => {
  it("lists enabled providers in order, then the rest, saying how to enable or why not", async () => {
    const comfyui = fakeProvider("comfyui", {
      healthCheck: () => Promise.resolve({ ok: false, detail: "ComfyUI is down" }),
    });
    const mock = fakeProvider("mock", { supports: { negativePrompt: false, seed: true, referenceImage: true } });
    const out = await status({ DARKROOM_PROVIDER_ORDER: "comfyui,mock" }, { comfyui, mock });
    expect(out.order).toEqual(["comfyui", "mock"]);
    expect(out.allow_paid_fallback).toBe(false);
    const free = { paid: false, estimated_cost_usd: { draft: 0, final: 0 } };
    expect(out.providers).toEqual([
      {
        name: "comfyui",
        enabled: true,
        healthy: false,
        detail: "ComfyUI is down",
        model: "comfyui-model",
        ...free,
        reference_image: false,
      },
      { name: "mock", enabled: true, healthy: true, detail: null, model: "mock-model", ...free, reference_image: true },
      {
        name: "openai",
        enabled: false,
        healthy: null,
        detail: "Not enabled: add openai to DARKROOM_PROVIDER_ORDER and set DARKROOM_OPENAI_API_KEY.",
        model: null,
        paid: true,
        estimated_cost_usd: null,
        reference_image: null,
      },
      {
        name: "gemini",
        enabled: false,
        healthy: null,
        detail: "Not available in this version of Darkroom yet.",
        model: null,
        paid: true,
        estimated_cost_usd: null,
        reference_image: null,
      },
    ]);
  });

  it("says a provider listed in the order but not built yet isn't available", async () => {
    const out = await status({ DARKROOM_PROVIDER_ORDER: "gemini,mock" }, { mock: fakeProvider("mock") });
    expect(out.providers[0]).toMatchObject({
      name: "gemini",
      enabled: true,
      healthy: null,
      detail: "Not available in this version of Darkroom yet.",
      estimated_cost_usd: null,
    });
  });

  it("gives a paid provider's estimates, and its health detail when its key is missing", async () => {
    const out = await status(
      { DARKROOM_PROVIDER_ORDER: "openai" },
      { openai: openai({ healthCheck: () => Promise.resolve({ ok: false, detail: "DARKROOM_OPENAI_API_KEY is not set" }) }) },
    );
    expect(out.providers[0]).toEqual({
      name: "openai",
      enabled: true,
      healthy: false,
      detail: "DARKROOM_OPENAI_API_KEY is not set",
      model: "openai-model",
      paid: true,
      estimated_cost_usd: { draft: 0.007, final: 0.021 },
      reference_image: false,
    });
  });

  it("notes when a paid provider behind a free one is only used on request", async () => {
    const providers = { comfyui: fakeProvider("comfyui"), openai: openai() };
    const gated = await status({ DARKROOM_PROVIDER_ORDER: "comfyui,openai" }, providers);
    expect(gated.providers[1]?.detail).toBe(
      "Used only when asked for by name: comfyui comes first, and DARKROOM_ALLOW_PAID_FALLBACK is off.",
    );
    const allowed = await status(
      { DARKROOM_PROVIDER_ORDER: "comfyui,openai", DARKROOM_ALLOW_PAID_FALLBACK: "true" },
      providers,
    );
    expect(allowed.providers[1]?.detail).toBeNull();
    expect(allowed.allow_paid_fallback).toBe(true);
  });

  it("reports today's spend against the cap", async () => {
    await ledger.reserve({ provider: "openai", estimateUsd: 0.0123, capUsd: 2 });
    const out = await status({ DARKROOM_PROVIDER_ORDER: "mock", DARKROOM_DAILY_CAP_USD: "0.5" }, { mock: fakeProvider("mock") });
    expect(out.spend).toEqual({ day_utc: "2026-10-02", spent_usd: 0.0123, cap_usd: 0.5, remaining_usd: 0.4877, error: null });
  });

  it("never reports negative remaining spend", async () => {
    await ledger.reserve({ provider: "openai", estimateUsd: 0.3, capUsd: 2 });
    const out = await status({ DARKROOM_PROVIDER_ORDER: "mock", DARKROOM_DAILY_CAP_USD: "0.1" }, { mock: fakeProvider("mock") });
    expect(out.spend.remaining_usd).toBe(0);
  });

  it("still lists providers when the ledger can't be read", async () => {
    await writeFile(join(dir, LEDGER_FILENAME), "garbage");
    const out = await status({ DARKROOM_PROVIDER_ORDER: "mock" }, { mock: fakeProvider("mock") });
    expect(out.providers[0]?.healthy).toBe(true);
    expect(out.spend).toMatchObject({ spent_usd: null, remaining_usd: null });
    expect(out.spend.error).toMatch(/corrupt/);
  });

  it("uses the router's health cache", async () => {
    const healthCheck = vi.fn(() => Promise.resolve({ ok: true }));
    const config = loadConfig({ DARKROOM_PROVIDER_ORDER: "mock" });
    const router = new Router(config, new Map([["mock", fakeProvider("mock", { healthCheck })]]), ledger);
    const deps = { config, router, ledger, implemented: new Set<ProviderName>(["mock"]) };
    await providerStatus(deps);
    await providerStatus(deps);
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });
});
