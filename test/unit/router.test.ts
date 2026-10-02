import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type ProviderName } from "../../src/config.js";
import { Ledger, LEDGER_FILENAME } from "../../src/ledger.js";
import { ContentRefusedError, ProviderError, type GenerateRequest, type ImageProvider } from "../../src/providers/types.js";
import { NoProviderError, Router } from "../../src/router.js";

const req: GenerateRequest = { prompt: "a mug", aspectRatio: "1:1", quality: "draft" };
const signal = new AbortController().signal;

let dir: string;
let ledger: Ledger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "darkroom-router-"));
  ledger = Ledger.inDir(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

function paidProvider(over: Partial<ImageProvider> = {}): ImageProvider {
  return fakeProvider("openai", {
    isPaid: true,
    estimateCostUsd: () => 0.08,
    generate: vi.fn(() =>
      Promise.resolve({ png: Buffer.from("x"), model: "gpt", width: 1, height: 1, seed: null, actualCostUsd: 0.05 }),
    ),
    ...over,
  });
}

const sick = (name: string) =>
  fakeProvider(name, { healthCheck: () => Promise.resolve({ ok: false, detail: "connection refused" }) });

function router(
  order: string,
  providers: Partial<Record<ProviderName, ImageProvider>>,
  env: Record<string, string> = {},
): Router {
  const map = new Map(Object.entries(providers) as [ProviderName, ImageProvider][]);
  return new Router(loadConfig({ DARKROOM_PROVIDER_ORDER: order, ...env }), map, ledger);
}

describe("Router", () => {
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
    const comfyui = sick("comfyui");
    const routed = await router("comfyui,mock", { comfyui, mock: fakeProvider("mock") }).generate(req, { signal });
    expect(routed.provider.name).toBe("mock");
    expect(routed.skipped).toEqual([{ provider: "comfyui", reason: "unhealthy: connection refused" }]);
    expect(comfyui.generate).not.toHaveBeenCalled();
  });

  it("treats a throwing health check as unhealthy", async () => {
    const broken = fakeProvider("comfyui", { healthCheck: () => Promise.reject(new Error("boom")) });
    const routed = await router("comfyui,mock", { comfyui: broken, mock: fakeProvider("mock") }).generate(req, {
      signal,
    });
    expect(routed.skipped).toEqual([{ provider: "comfyui", reason: "unhealthy: boom" }]);
  });

  it("fails clearly when nothing in the order can run", async () => {
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

describe("Router fallback", () => {
  const failing = (name: string, err: Error) => fakeProvider(name, { generate: vi.fn(() => Promise.reject(err)) });

  it("falls back to the next provider when one fails, and says why", async () => {
    const comfyui = failing("comfyui", new Error("GPU fell over"));
    const routed = await router("comfyui,mock", { comfyui, mock: fakeProvider("mock") }).generate(req, { signal });
    expect(routed.provider.name).toBe("mock");
    expect(routed.skipped).toEqual([{ provider: "comfyui", reason: "failed: GPU fell over" }]);
  });

  it("lists every failure when nothing in the order succeeds", async () => {
    const comfyui = failing("comfyui", new Error("timed out"));
    const mock = failing("mock", new Error("disk full"));
    const err = await router("comfyui,mock", { comfyui, mock })
      .generate(req, { signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoProviderError);
    expect((err as Error).message).toBe(
      "No image provider could take this request (comfyui: failed: timed out; mock: failed: disk full).",
    );
  });

  it("returns a refusal from a free provider without trying the next one", async () => {
    const mock = fakeProvider("mock");
    const comfyui = failing("comfyui", new ContentRefusedError("blocked"));
    await expect(router("comfyui,mock", { comfyui, mock }).generate(req, { signal })).rejects.toThrow(
      ContentRefusedError,
    );
    expect(mock.generate).not.toHaveBeenCalled();
  });

  it("stops when the caller cancels instead of trying the next provider", async () => {
    const controller = new AbortController();
    const mock = fakeProvider("mock");
    const comfyui = fakeProvider("comfyui", {
      generate: () => {
        controller.abort();
        return Promise.reject(new ProviderError("Generation was cancelled"));
      },
    });
    await expect(
      router("comfyui,mock", { comfyui, mock }).generate(req, { signal: controller.signal }),
    ).rejects.toThrow("Generation was cancelled");
    expect(mock.generate).not.toHaveBeenCalled();
  });

  it("doesn't fall back from an explicit provider that fails", async () => {
    const mock = fakeProvider("mock");
    const comfyui = failing("comfyui", new ProviderError("GPU fell over"));
    await expect(router("comfyui,mock", { comfyui, mock }).generate(req, { provider: "comfyui", signal })).rejects.toThrow(
      "GPU fell over",
    );
    expect(mock.generate).not.toHaveBeenCalled();
  });

  it("keeps a failed paid call's reservation and moves on to the next provider", async () => {
    const openai = paidProvider({ generate: () => Promise.reject(new Error("socket hang up")) });
    const routed = await router("openai,mock", { openai, mock: fakeProvider("mock") }).generate(req, { signal });
    expect(routed.provider.name).toBe("mock");
    expect(routed.skipped).toEqual([{ provider: "openai", reason: "failed: socket hang up" }]);
    expect(await ledger.spentTodayUsd()).toBe(0.08);
  });
});

describe("Router health cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses a healthy result for 60s, then checks again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const healthCheck = vi.fn(() => Promise.resolve({ ok: true }));
    const r = router("mock", { mock: fakeProvider("mock", { healthCheck }) });
    await r.generate(req, { signal });
    vi.advanceTimersByTime(59_000);
    await r.generate(req, { signal });
    expect(healthCheck).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    await r.generate(req, { signal });
    expect(healthCheck).toHaveBeenCalledTimes(2);
  });

  it("doesn't cache an unhealthy result, so a provider that comes back is used at once", async () => {
    const healthCheck = vi
      .fn<ImageProvider["healthCheck"]>()
      .mockResolvedValueOnce({ ok: false, detail: "connection refused" })
      .mockResolvedValue({ ok: true });
    const r = router("comfyui,mock", { comfyui: fakeProvider("comfyui", { healthCheck }), mock: fakeProvider("mock") });
    expect((await r.generate(req, { signal })).provider.name).toBe("mock");
    expect((await r.generate(req, { signal })).provider.name).toBe("comfyui");
  });

  it("checks again after a provider fails", async () => {
    const healthCheck = vi.fn(() => Promise.resolve({ ok: true }));
    const generate = vi
      .fn<ImageProvider["generate"]>()
      .mockRejectedValueOnce(new Error("GPU fell over"))
      .mockResolvedValue({ png: Buffer.from("c"), model: "c", width: 1, height: 1, seed: 1 });
    const comfyui = fakeProvider("comfyui", { healthCheck, generate });
    const r = router("comfyui,mock", { comfyui, mock: fakeProvider("mock") });
    await r.generate(req, { signal });
    await r.generate(req, { signal });
    expect(healthCheck).toHaveBeenCalledTimes(2);
  });
});

describe("Router spend", () => {
  it("reserves a paid call's estimate, then settles to the actual cost", async () => {
    const openai = paidProvider({
      generate: vi.fn(async () => {
        expect(await ledger.spentTodayUsd()).toBe(0.08); // reserved before the call
        return { png: Buffer.from("x"), model: "gpt", width: 1, height: 1, seed: null, actualCostUsd: 0.05 };
      }),
    });
    const routed = await router("openai", { openai }).generate(req, { signal });
    expect(routed.provider.name).toBe("openai");
    expect(await ledger.spentTodayUsd()).toBe(0.05);
  });

  it("records an actual cost above the estimate, and warns about it", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const openai = paidProvider({
        generate: () =>
          Promise.resolve({ png: Buffer.from("x"), model: "gpt", width: 1, height: 1, seed: null, actualCostUsd: 0.12 }),
      });
      await router("openai", { openai }).generate(req, { signal });
      expect(await ledger.spentTodayUsd()).toBe(0.12);
      expect(stderr).toHaveBeenCalledWith(
        '[darkroom] warn: actual cost exceeded the estimate {"provider":"openai","estimate_usd":0.08,"actual_usd":0.12}\n',
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("keeps the estimate when a paid provider reports no actual cost", async () => {
    const openai = paidProvider({
      generate: () => Promise.resolve({ png: Buffer.from("x"), model: "gpt", width: 1, height: 1, seed: null }),
    });
    await router("openai", { openai }).generate(req, { signal });
    expect(await ledger.spentTodayUsd()).toBe(0.08);
  });

  it("never records spend for free providers", async () => {
    await router("mock", { mock: fakeProvider("mock", { estimateCostUsd: () => 1 }) }).generate(req, { signal });
    expect(await ledger.spentTodayUsd()).toBe(0);
  });

  it("refuses an explicit paid request over the cap without calling the provider", async () => {
    const openai = paidProvider();
    const err = await router("openai", { openai }, { DARKROOM_DAILY_CAP_USD: "0.05" })
      .generate(req, { provider: "openai", signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoProviderError);
    expect((err as Error).message).toMatch(
      /^No image provider could take this request \(openai: daily spend cap reached: \$0\.00 of \$0\.05/,
    );
    expect(openai.generate).not.toHaveBeenCalled();
    expect(await ledger.spentTodayUsd()).toBe(0);
  });

  it("refuses once earlier calls have used up the cap", async () => {
    const openai = paidProvider();
    const r = router("openai", { openai }, { DARKROOM_DAILY_CAP_USD: "0.10" });
    await r.generate(req, { signal }); // reserves 0.08, settles at 0.05
    await expect(r.generate(req, { signal })).rejects.toThrow(/daily spend cap reached: \$0\.05 of \$0\.10/);
    expect(openai.generate).toHaveBeenCalledTimes(1);
  });

  it("holds the cap under parallel calls", async () => {
    const openai = paidProvider();
    const r = router("openai", { openai }, { DARKROOM_DAILY_CAP_USD: "0.20" });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => r.generate(req, { signal })));
    // Each reserves 0.08 up front, so only two fit under 0.20 even though each settles at 0.05.
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(2);
    expect(openai.generate).toHaveBeenCalledTimes(2);
  });

  it("keeps the reservation when a paid call fails ambiguously", async () => {
    const openai = paidProvider({ generate: () => Promise.reject(new Error("socket hang up")) });
    await expect(router("openai", { openai }).generate(req, { signal })).rejects.toThrow("socket hang up");
    expect(await ledger.spentTodayUsd()).toBe(0.08);
  });

  it("releases the reservation when the provider says nothing was charged", async () => {
    const openai = paidProvider({
      generate: () => Promise.reject(new ProviderError("HTTP 401", { notCharged: true })),
    });
    await expect(router("openai", { openai }).generate(req, { signal })).rejects.toThrow("HTTP 401");
    expect(await ledger.spentTodayUsd()).toBe(0);
  });

  it("returns a refusal as-is and releases its reservation when it wasn't charged", async () => {
    const mock = fakeProvider("mock");
    const openai = paidProvider({
      generate: () => Promise.reject(new ContentRefusedError("moderation_blocked", { notCharged: true })),
    });
    await expect(router("openai,mock", { openai, mock }).generate(req, { signal })).rejects.toThrow(
      ContentRefusedError,
    );
    expect(mock.generate).not.toHaveBeenCalled();
    expect(await ledger.spentTodayUsd()).toBe(0);
  });

  it("doesn't reserve or call a paid provider when the request was already cancelled", async () => {
    const openai = paidProvider();
    await expect(router("openai", { openai }).generate(req, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(openai.generate).not.toHaveBeenCalled();
    expect(await ledger.spentTodayUsd()).toBe(0);
  });

  it("doesn't call a paid provider when the ledger is unreadable", async () => {
    await writeFile(join(dir, LEDGER_FILENAME), "garbage");
    const openai = paidProvider();
    await expect(router("openai", { openai }).generate(req, { signal })).rejects.toThrow(/spend ledger .* is corrupt/);
    expect(openai.generate).not.toHaveBeenCalled();
  });

  it("doesn't reserve for an unhealthy paid provider (e.g. no key)", async () => {
    const openai = paidProvider({
      healthCheck: () => Promise.resolve({ ok: false, detail: "set DARKROOM_OPENAI_API_KEY" }),
    });
    await expect(router("openai", { openai }).generate(req, { signal })).rejects.toThrow(
      "No image provider could take this request (openai: unhealthy: set DARKROOM_OPENAI_API_KEY).",
    );
    expect(await ledger.spentTodayUsd()).toBe(0);
  });
});

describe("Router paid gate", () => {
  const GATED =
    "not used because comfyui was skipped and this provider costs money; DARKROOM_ALLOW_PAID_FALLBACK=true allows this";

  it("doesn't step from an unhealthy free provider to a paid one by default", async () => {
    const openai = paidProvider();
    const err = await router("comfyui,openai", { comfyui: sick("comfyui"), openai })
      .generate(req, { signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoProviderError);
    expect((err as NoProviderError).skipped).toEqual([
      { provider: "comfyui", reason: "unhealthy: connection refused" },
      { provider: "openai", reason: GATED },
    ]);
    expect(openai.generate).not.toHaveBeenCalled();
    expect(await ledger.spentTodayUsd()).toBe(0);
  });

  it("doesn't step from an unavailable provider to a paid one by default", async () => {
    const openai = paidProvider();
    await expect(router("comfyui,openai", { openai }).generate(req, { signal })).rejects.toThrow(NoProviderError);
    expect(openai.generate).not.toHaveBeenCalled();
  });

  it("doesn't step from a failed free provider to a paid one by default", async () => {
    const openai = paidProvider();
    const comfyui = fakeProvider("comfyui", { generate: () => Promise.reject(new Error("timed out")) });
    const err = await router("comfyui,openai", { comfyui, openai })
      .generate(req, { signal })
      .catch((e: unknown) => e);
    expect((err as NoProviderError).skipped).toEqual([
      { provider: "comfyui", reason: "failed: timed out" },
      {
        provider: "openai",
        reason:
          "not used because comfyui failed and this provider costs money; DARKROOM_ALLOW_PAID_FALLBACK=true allows this",
      },
    ]);
    expect(openai.generate).not.toHaveBeenCalled();
    expect(await ledger.spentTodayUsd()).toBe(0);
  });

  it("steps from a failed free provider to a paid one with DARKROOM_ALLOW_PAID_FALLBACK=true", async () => {
    const comfyui = fakeProvider("comfyui", { generate: () => Promise.reject(new Error("timed out")) });
    const routed = await router(
      "comfyui,openai",
      { comfyui, openai: paidProvider() },
      { DARKROOM_ALLOW_PAID_FALLBACK: "true" },
    ).generate(req, { signal });
    expect(routed.provider.name).toBe("openai");
    expect(routed.skipped).toEqual([{ provider: "comfyui", reason: "failed: timed out" }]);
  });

  it("does step to the paid provider with DARKROOM_ALLOW_PAID_FALLBACK=true, and says why", async () => {
    const openai = paidProvider();
    const routed = await router(
      "comfyui,openai",
      { comfyui: sick("comfyui"), openai },
      { DARKROOM_ALLOW_PAID_FALLBACK: "true" },
    ).generate(req, { signal });
    expect(routed.provider.name).toBe("openai");
    expect(routed.skipped).toEqual([{ provider: "comfyui", reason: "unhealthy: connection refused" }]);
  });

  it("still applies the cap after an allowed fallback", async () => {
    const openai = paidProvider();
    await expect(
      router(
        "comfyui,openai",
        { comfyui: sick("comfyui"), openai },
        { DARKROOM_ALLOW_PAID_FALLBACK: "true", DARKROOM_DAILY_CAP_USD: "0" },
      ).generate(req, { signal }),
    ).rejects.toThrow(/openai: daily spend cap reached/);
    expect(openai.generate).not.toHaveBeenCalled();
  });

  it("doesn't count a skipped paid provider that isn't built yet as a free one", async () => {
    const routed = await router("gemini,openai", { openai: paidProvider() }).generate(req, { signal });
    expect(routed.provider.name).toBe("openai");
    expect(routed.skipped).toEqual([{ provider: "gemini", reason: "not available in this version of Darkroom yet" }]);
  });

  it("uses a paid provider listed first, since no free provider was skipped", async () => {
    const routed = await router("openai,comfyui", { openai: paidProvider(), comfyui: fakeProvider("comfyui") }).generate(
      req,
      { signal },
    );
    expect(routed.provider.name).toBe("openai");
  });

  it("lets an explicit paid choice through even when a free provider is down", async () => {
    const routed = await router("comfyui,openai", { comfyui: sick("comfyui"), openai: paidProvider() }).generate(req, {
      provider: "openai",
      signal,
    });
    expect(routed.provider.name).toBe("openai");
    expect(routed.skipped).toEqual([]);
  });

  it("moves on from a paid provider to a free one without the flag", async () => {
    const routed = await router("openai,mock", { openai: paidProvider(), mock: fakeProvider("mock") }, {
      DARKROOM_DAILY_CAP_USD: "0",
    }).generate(req, { signal });
    expect(routed.provider.name).toBe("mock");
    expect(routed.skipped[0]?.reason).toMatch(/^daily spend cap reached/);
  });
});
