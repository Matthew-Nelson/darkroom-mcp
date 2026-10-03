import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config.js";
import { costFromUsage, createGeminiProvider, GEMINI_MODELS, geminiImageSize } from "../../src/providers/gemini.js";
import { ContentRefusedError, ProviderError, type GenerateRequest } from "../../src/providers/types.js";

// Offline tests against fixtures in test/fixtures/gemini.

const KEY = "AIzaTHISISAFAKEKEYFORTESTS0123456789abc";
const request: GenerateRequest = { prompt: "a mug that says DARKROOM", aspectRatio: "1:1", quality: "draft" };
const signal = new AbortController().signal;
const BENCHMARK_PROMPT =
  "a ceramic coffee mug on a wooden desk by a window, morning light, the mug reads DARKROOM in bold letters";

const fixtureText = (name: string) => readFileSync(new URL(`../fixtures/gemini/${name}`, import.meta.url), "utf8");

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = {
      url: input instanceof Request ? input.url : String(input),
      init: init ?? {},
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { fetch: fn, calls };
}

const reply = (name: string, status = 200) => () => new Response(fixtureText(name), { status });

function provider(
  fetchFn: typeof fetch,
  over: { apiKey?: string | undefined; timeoutMs?: number; model?: string } = {},
) {
  return createGeminiProvider({
    apiKey: "apiKey" in over ? over.apiKey : KEY,
    model: over.model ?? "gemini-3.1-flash-image",
    timeoutMs: over.timeoutMs ?? 60_000,
    fetch: fetchFn,
  });
}

const failure = (p: Promise<unknown>) => p.then(() => new Error("expected a failure"), (e: unknown) => e as Error);

/** A response with one candidate made of `parts`. */
const candidate = (parts: unknown[], finishReason = "STOP") => () =>
  Response.json({ candidates: [{ content: { role: "model", parts }, finishReason }] });

describe("gemini provider", () => {
  it("is paid, supports a seed but no negative prompt, and reports a cost estimate", () => {
    const p = provider(fakeFetch(reply("generate-200-draft.json")).fetch);
    expect(p.name).toBe("gemini");
    expect(p.model).toBe("gemini-3.1-flash-image");
    expect(p.isPaid).toBe(true);
    expect(p.supports).toEqual({ negativePrompt: false, seed: true });
    const draft = p.estimateCostUsd(request);
    const final = p.estimateCostUsd({ ...request, quality: "final" });
    expect(final).toBeGreaterThan(draft);
  });

  it("estimates at least the list price per image (512px $0.045, 1K $0.067)", () => {
    const p = provider(fakeFetch(reply("generate-200-draft.json")).fetch);
    expect(p.estimateCostUsd(request)).toBeGreaterThan(0.0448);
    expect(p.estimateCostUsd({ ...request, quality: "final" })).toBeGreaterThan(0.0672);
    expect(p.estimateCostUsd({ ...request, quality: "final" })).toBeLessThan(0.1);
  });

  it.each([
    ["generate-200-draft.json", "draft"],
    ["generate-200-final.json", "final"],
  ] as const)("estimates at least the recorded real cost (%s)", async (fixture, quality) => {
    const p = provider(fakeFetch(reply(fixture)).fetch);
    const req = { prompt: BENCHMARK_PROMPT, aspectRatio: "1:1", quality } as const;
    const actual = (await p.generate(req, signal)).actualCostUsd ?? 0;
    expect(actual).toBeGreaterThan(0);
    expect(p.estimateCostUsd(req)).toBeGreaterThanOrEqual(actual);
    expect(p.estimateCostUsd(req)).toBeLessThan(actual * 1.5); // high, but not wildly so
  });

  it("estimates a long prompt's input tokens", () => {
    const p = provider(fakeFetch(reply("generate-200-draft.json")).fetch);
    const short = p.estimateCostUsd(request);
    const long = p.estimateCostUsd({ ...request, prompt: "x".repeat(4000) });
    expect(long - short).toBeGreaterThan((1000 * 0.5) / 1e6);
  });

  it("refuses to start with a model it has no prices for", () => {
    expect(() => provider(fakeFetch(reply("generate-200-draft.json")).fetch, { model: "gemini-2.5-flash-image" })).toThrow(
      ConfigError,
    );
  });

  it("is healthy with a key, and explains the missing key without one", async () => {
    const { fetch, calls } = fakeFetch(reply("generate-200-draft.json"));
    expect(await provider(fetch).healthCheck()).toEqual({ ok: true });
    const health = await provider(fetch, { apiKey: undefined }).healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/^DARKROOM_GEMINI_API_KEY is not set\. Darkroom ignores a generic GEMINI_API_KEY/);
    expect(calls).toHaveLength(0); // health checks are free
  });

  it("won't call the API without a key", async () => {
    const { fetch, calls } = fakeFetch(reply("generate-200-draft.json"));
    const err = await failure(provider(fetch, { apiKey: undefined }).generate(request, signal));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).notCharged).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("posts the prompt, aspect ratio, size, and seed, with the key in a header and never the URL", async () => {
    const { fetch, calls } = fakeFetch(reply("generate-200-draft.json"));
    await provider(fetch).generate({ ...request, aspectRatio: "3:2", negativePrompt: "blurry", seed: 42 }, signal);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
    );
    expect(call?.url).not.toContain(KEY);
    expect(call?.init.method).toBe("POST");
    expect(new Headers(call?.init.headers).get("x-goog-api-key")).toBe(KEY);
    expect(call?.body).toEqual({
      contents: [{ role: "user", parts: [{ text: request.prompt }] }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        seed: 42,
        imageConfig: { aspectRatio: "3:2", imageSize: "512" },
      },
    });
  });

  it("picks a random 32-bit seed when none is given, sends it, and returns it", async () => {
    const { fetch, calls } = fakeFetch(reply("generate-200-draft.json"));
    const result = await provider(fetch).generate(request, signal);
    const sent = (calls[0]?.body.generationConfig as { seed?: unknown }).seed;
    expect(Number.isInteger(sent)).toBe(true);
    expect(sent).toBeGreaterThanOrEqual(0);
    expect(sent).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(result.seed).toBe(sent);
  });

  it("refuses a seed too big for Gemini before sending anything, as uncharged", async () => {
    const { fetch, calls } = fakeFetch(reply("generate-200-draft.json"));
    const ok = await provider(fetch).generate({ ...request, seed: 2 ** 31 - 1 }, signal);
    expect(ok.seed).toBe(2 ** 31 - 1);
    const err = await failure(provider(fetch).generate({ ...request, seed: 2 ** 31 }, signal));
    expect(err.message).toBe(
      "Gemini seeds go up to 2147483647, and this one is 2147483648 (perhaps from another provider). Use a smaller seed, or none.",
    );
    expect((err as ProviderError).notCharged).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("renders final at 1K", async () => {
    const { fetch, calls } = fakeFetch(reply("generate-200-draft.json"));
    await provider(fetch).generate({ ...request, aspectRatio: "16:9", quality: "final" }, signal);
    expect(calls[0]?.body).toMatchObject({ generationConfig: { imageConfig: { aspectRatio: "16:9", imageSize: "1K" } } });
  });

  it("renders Flash Lite drafts at 1K, its only size", () => {
    expect(geminiImageSize("gemini-3.1-flash-lite-image", "draft")).toBe("1K");
    expect(geminiImageSize("gemini-3.1-flash-image", "draft")).toBe("512");
    const lite = provider(fakeFetch(reply("generate-200-draft.json")).fetch, { model: "gemini-3.1-flash-lite-image" });
    expect(lite.estimateCostUsd(request)).toBe(lite.estimateCostUsd({ ...request, quality: "final" }));
  });

  it("returns a PNG (Gemini sends JPEG), its real size, the seed, and the actual cost from usage", async () => {
    const onProgress: string[] = [];
    const result = await provider(fakeFetch(reply("generate-200-draft.json")).fetch).generate(
      { ...request, seed: 7 },
      signal,
      (u) => onProgress.push(u.message),
    );
    expect((await sharp(result.png).metadata()).format).toBe("png");
    expect(result).toMatchObject({ model: "gemini-3.1-flash-image", width: 8, height: 8, seed: 7 });
    // Recorded usage: 24 prompt tokens at $0.50/M, 747 image tokens at $60/M, and the other
    // 449 output tokens (no modality given; thinking) at the $3/M text rate.
    expect(result.actualCostUsd).toBe(0.046179);
    expect(onProgress).toEqual(["Waiting for Gemini (gemini-3.1-flash-image, 512px, 1:1)"]);
  });

  it("skips interim thought images and takes the last final one", async () => {
    const png = (width: number) =>
      sharp({ create: { width, height: 8, channels: 3, background: "#808080" } })
        .png()
        .toBuffer()
        .then((b) => ({ inlineData: { mimeType: "image/png", data: b.toString("base64") } }));
    const parts = [{ ...(await png(10)), thought: true }, await png(20), { ...(await png(30)), thought: true }];
    const result = await provider(fakeFetch(candidate(parts)).fetch).generate(request, signal);
    expect(result.width).toBe(20);
  });

  it("converts a JPEG to PNG", async () => {
    const jpeg = await sharp({ create: { width: 16, height: 8, channels: 3, background: "#808080" } })
      .jpeg()
      .toBuffer();
    const parts = [{ inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } }];
    const result = await provider(fakeFetch(candidate(parts)).fetch).generate(request, signal);
    expect((await sharp(result.png).metadata()).format).toBe("png");
    expect([result.width, result.height]).toEqual([16, 8]);
    expect(result.actualCostUsd).toBeUndefined(); // no usage in the response
  });

  it("fails clearly, as possibly charged, when the response has only text", async () => {
    const parts = [{ text: "Here is a thought", thought: true }, { text: "I can only describe this mug." }];
    const err = await failure(provider(fakeFetch(candidate(parts)).fetch).generate(request, signal));
    expect(err).not.toBeInstanceOf(ContentRefusedError);
    expect(err.message).toBe(`Gemini's response had no image in it. It said: "I can only describe this mug."`);
    expect((err as ProviderError).notCharged).toBe(false);
  });

  it("names a NO_IMAGE finish", async () => {
    const err = await failure(provider(fakeFetch(candidate([], "NO_IMAGE")).fetch).generate(request, signal));
    expect(err.message).toBe("Gemini's response had no image in it (NO_IMAGE).");
    expect(err).not.toBeInstanceOf(ContentRefusedError);
  });

  it("turns a blocked prompt into an uncharged refusal", async () => {
    const err = await failure(provider(fakeFetch(reply("prompt-blocked.json")).fetch).generate(request, signal));
    expect(err).toBeInstanceOf(ContentRefusedError);
    expect(err.message).toBe("Gemini blocked this prompt (PROHIBITED_CONTENT)");
    expect((err as ContentRefusedError).notCharged).toBe(true);
  });

  it("treats an image refused during generation as a possibly charged refusal", async () => {
    const err = await failure(provider(fakeFetch(reply("finish-image-safety.json")).fetch).generate(request, signal));
    expect(err).toBeInstanceOf(ContentRefusedError);
    expect(err.message).toBe("Gemini refused to finish this image (IMAGE_SAFETY)");
    expect((err as ContentRefusedError).notCharged).toBe(false);
  });

  it("explains a rejected key (HTTP 400, API_KEY_INVALID) without echoing any of it", async () => {
    const echoed = fixtureText("error-400-api-key.json").replace("Please pass", `${KEY}. Please pass`);
    const err = await failure(provider(fakeFetch(() => new Response(echoed, { status: 400 })).fetch).generate(request, signal));
    expect(err.message).toMatch(/^Gemini rejected the API key \(HTTP 400\)\. Check DARKROOM_GEMINI_API_KEY: API key not valid/);
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain("THISISAFAKEKEY");
    expect((err as ProviderError).notCharged).toBe(true);
  });

  it.each([
    [403, /^Gemini refused access \(HTTP 403\)\. Check that the key's project has the Gemini API enabled/],
    [429, /^Gemini's rate limit or quota was hit \(HTTP 429\)\. Wait and retry, or check the project's quotas\. A project without billing also gets this/],
    [404, /^Gemini rejected the request \(HTTP 404, NOT_FOUND\): no such model$/],
  ])("reports HTTP %s as uncharged", async (status, message) => {
    const body = { error: { code: status, message: "no such model", status: status === 404 ? "NOT_FOUND" : "X" } };
    const err = await failure(provider(fakeFetch(() => Response.json(body, { status })).fetch).generate(request, signal));
    expect(err.message).toMatch(message);
    expect((err as ProviderError).notCharged).toBe(true);
  });

  it("treats a 5xx as possibly charged", async () => {
    const err = await failure(
      provider(fakeFetch(() => new Response("upstream error", { status: 503 })).fetch).generate(request, signal),
    );
    expect(err.message).toBe("Gemini returned a server error (HTTP 503). It may still have billed the request.");
    expect((err as ProviderError).notCharged).toBe(false);
  });

  it.each([
    ["ECONNREFUSED", true],
    ["ECONNRESET", false],
  ])("classifies a %s network error (uncharged: %s)", async (code, notCharged) => {
    const fetchFn = () =>
      Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }));
    const err = await failure(provider(fetchFn).generate(request, signal));
    expect(err.message).toMatch(new RegExp(`^Can't reach Gemini \\(${code}\\)\\.`));
    expect((err as ProviderError).notCharged).toBe(notCharged);
  });

  it("times out with a message naming the setting, and keeps the charge assumption", async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      });
    const err = await failure(provider(hang, { timeoutMs: 20 }).generate(request, signal));
    expect(err.message).toBe(
      "Gemini didn't finish within 0s (DARKROOM_GEMINI_TIMEOUT_MS). It may still have billed the request.",
    );
    expect((err as ProviderError).notCharged).toBe(false);
  });

  it("aborts the HTTP request when the caller cancels", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        seen = init?.signal ?? undefined;
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
        controller.abort();
      });
    const err = await failure(provider(hang).generate(request, controller.signal));
    expect(err.name).toBe("AbortError");
    expect(seen?.aborted).toBe(true);
  });

  it("doesn't start when the signal is already aborted, and says nothing was charged", async () => {
    const { fetch, calls } = fakeFetch(reply("generate-200-draft.json"));
    const err = await failure(provider(fetch).generate(request, AbortSignal.abort()));
    expect(err.message).toBe("Cancelled before the request was sent to Gemini.");
    expect((err as ProviderError).notCharged).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("gemini costFromUsage", () => {
  const rates = GEMINI_MODELS["gemini-3.1-flash-image"];
  if (!rates) throw new Error("missing rates");

  it("uses the published gemini-3.1-flash-image rates", () => {
    expect(rates).toEqual({ input: 0.5, textOutput: 3, imageOutput: 60, draftSize: "512" });
  });

  it("prices prompt, image output, text output, and thinking separately", () => {
    const usage = {
      promptTokenCount: 100,
      candidatesTokenCount: 1150,
      thoughtsTokenCount: 200,
      candidatesTokensDetails: [
        { modality: "IMAGE", tokenCount: 1120 },
        { modality: "TEXT", tokenCount: 30 },
      ],
    };
    expect(costFromUsage(usage, rates)).toBe(roundUsd((100 * 0.5 + 1120 * 60 + (30 + 200) * 3) / 1e6));
  });

  it("prices output at the image rate when there's no breakdown, rather than under-count", () => {
    expect(costFromUsage({ promptTokenCount: 0, candidatesTokenCount: 1000 }, rates)).toBe(0.06);
  });

  it("prices output at the image rate when the breakdown has no IMAGE entry", () => {
    expect(costFromUsage({ promptTokenCount: 0, candidatesTokenCount: 1120, candidatesTokensDetails: [] }, rates)).toBe(
      0.0672,
    );
    const textOnly = [{ modality: "TEXT", tokenCount: 1120 }];
    expect(costFromUsage({ promptTokenCount: 0, candidatesTokenCount: 1120, candidatesTokensDetails: textOnly }, rates)).toBe(
      0.0672,
    );
  });

  it("returns undefined without usage", () => {
    expect(costFromUsage(undefined, rates)).toBeUndefined();
    expect(costFromUsage({ promptTokenCount: 10 }, rates)).toBeUndefined();
  });
});

function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}
