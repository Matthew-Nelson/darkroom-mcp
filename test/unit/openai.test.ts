import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config.js";
import {
  costFromUsage,
  createOpenAIProvider,
  MIN_PIXELS,
  OPENAI_RATES,
  openaiSize,
  redactKey,
} from "../../src/providers/openai.js";
import {
  ASPECT_RATIOS,
  ContentRefusedError,
  ProviderError,
  QUALITIES,
  type GenerateRequest,
} from "../../src/providers/types.js";

// Offline tests against fixtures in test/fixtures/openai.

const KEY = "sk-proj-THISISAFAKEKEYFORTESTS0123456789";
const request: GenerateRequest = { prompt: "a mug that says DARKROOM", aspectRatio: "1:1", quality: "draft" };
const signal = new AbortController().signal;

const fixtureText = (name: string) => readFileSync(new URL(`../fixtures/openai/${name}`, import.meta.url), "utf8");

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

function provider(fetchFn: typeof fetch, over: { apiKey?: string | undefined; timeoutMs?: number } = {}) {
  return createOpenAIProvider({
    apiKey: "apiKey" in over ? over.apiKey : KEY,
    model: "gpt-image-2.5-flare",
    timeoutMs: over.timeoutMs ?? 60_000,
    fetch: fetchFn,
  });
}

const failure = (p: Promise<unknown>) => p.then(() => new Error("expected a failure"), (e: unknown) => e as Error);

describe("openai provider", () => {
  it("is paid, has no seed or negative prompt, and reports a cost estimate", () => {
    const p = provider(fakeFetch(reply("generations-200.json")).fetch);
    expect(p.name).toBe("openai");
    expect(p.isPaid).toBe(true);
    expect(p.supports).toEqual({ negativePrompt: false, seed: false });
    const draft = p.estimateCostUsd(request);
    const final = p.estimateCostUsd({ ...request, quality: "final" });
    expect(draft).toBeGreaterThan(0);
    expect(final).toBeGreaterThan(draft);
    expect(final).toBeLessThan(0.2);
  });

  it("refuses to start with a model it has no prices for", () => {
    expect(() =>
      createOpenAIProvider({ apiKey: KEY, model: "dall-e-3", timeoutMs: 60_000, fetch: fakeFetch(reply("x")).fetch }),
    ).toThrow(ConfigError);
  });

  it("is healthy with a key, and explains the missing key without one", async () => {
    const { fetch, calls } = fakeFetch(reply("generations-200.json"));
    expect(await provider(fetch).healthCheck()).toEqual({ ok: true });
    const health = await provider(fetch, { apiKey: undefined }).healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/^DARKROOM_OPENAI_API_KEY is not set\. Darkroom ignores a generic OPENAI_API_KEY/);
    expect(calls).toHaveLength(0); // health checks are free
  });

  it("won't call the API without a key", async () => {
    const { fetch, calls } = fakeFetch(reply("generations-200.json"));
    const err = await failure(provider(fetch, { apiKey: undefined }).generate(request, signal));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).notCharged).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("posts the prompt, size, and quality with the key in a header", async () => {
    const { fetch, calls } = fakeFetch(reply("generations-200.json"));
    await provider(fetch).generate({ ...request, negativePrompt: "blurry", seed: 42 }, signal);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.openai.com/v1/images/generations");
    expect(call?.url).not.toContain(KEY);
    expect(call?.init.method).toBe("POST");
    expect(new Headers(call?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call?.body).toEqual({
      model: "gpt-image-2.5-flare",
      prompt: request.prompt,
      n: 1,
      size: "816x816",
      quality: "low",
      output_format: "png",
    });
  });

  it("renders final at about 1MP and high quality", async () => {
    const { fetch, calls } = fakeFetch(reply("generations-200.json"));
    await provider(fetch).generate({ ...request, aspectRatio: "16:9", quality: "final" }, signal);
    expect(calls[0]?.body).toMatchObject({ size: "1360x768", quality: "high" });
  });

  it("returns the PNG, its real size, no seed, and the actual cost from usage", async () => {
    const onProgress: string[] = [];
    const result = await provider(fakeFetch(reply("generations-200.json")).fetch).generate(request, signal, (u) =>
      onProgress.push(u.message),
    );
    expect((await sharp(result.png).metadata()).format).toBe("png");
    expect(result).toMatchObject({ model: "gpt-image-2.5-flare", width: 8, height: 8, seed: null });
    // Fixture usage: 24 text input tokens at $5/M, 272 output tokens at $30/M.
    expect(result.actualCostUsd).toBe(0.00828);
    expect(onProgress).toEqual(["Waiting for OpenAI (gpt-image-2.5-flare, low quality, 816×816)"]);
  });

  it("converts a non-PNG image to PNG", async () => {
    const webp = await sharp({ create: { width: 16, height: 8, channels: 3, background: "#808080" } })
      .webp()
      .toBuffer();
    const body = { data: [{ b64_json: webp.toString("base64") }] };
    const result = await provider(fakeFetch(() => Response.json(body)).fetch).generate(request, signal);
    expect((await sharp(result.png).metadata()).format).toBe("png");
    expect([result.width, result.height]).toEqual([16, 8]);
    expect(result.actualCostUsd).toBeUndefined(); // no usage in the response
  });

  it("fails clearly when the response has no image", async () => {
    const err = await failure(provider(fakeFetch(() => Response.json({ data: [] })).fetch).generate(request, signal));
    expect(err.message).toBe("OpenAI's response had no image in it.");
    expect((err as ProviderError).notCharged).toBe(false);
  });

  it("turns an input moderation block into an uncharged refusal", async () => {
    const err = await failure(provider(fakeFetch(reply("error-moderation.json", 400)).fetch).generate(request, signal));
    expect(err).toBeInstanceOf(ContentRefusedError);
    expect(err.message).toBe("OpenAI's moderation blocked this request (input check; harassment)");
    expect((err as ContentRefusedError).notCharged).toBe(true);
  });

  it("treats an output moderation block as possibly charged", async () => {
    const body = JSON.parse(fixtureText("error-moderation.json")) as {
      error: { moderation_details: { moderation_stage: string } };
    };
    body.error.moderation_details.moderation_stage = "output";
    const err = await failure(provider(fakeFetch(() => Response.json(body, { status: 400 })).fetch).generate(request, signal));
    expect(err).toBeInstanceOf(ContentRefusedError);
    expect((err as ContentRefusedError).notCharged).toBe(false);
  });

  it("explains a rejected key without echoing any of it", async () => {
    const echoed = fixtureText("error-401.json").replace("sk-proj-abcdefgh**************wxyz", KEY);
    const err = await failure(provider(fakeFetch(() => new Response(echoed, { status: 401 })).fetch).generate(request, signal));
    expect(err.message).toMatch(/^OpenAI rejected the API key \(HTTP 401\)\. Check DARKROOM_OPENAI_API_KEY: Incorrect API key/);
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain("THISISAFAKEKEY");
    expect((err as ProviderError).notCharged).toBe(true);
  });

  it("reports other 4xx errors as uncharged, with OpenAI's message", async () => {
    const err = await failure(provider(fakeFetch(reply("error-400-size.json", 400)).fetch).generate(request, signal));
    expect(err.message).toBe(
      'OpenAI rejected the request (HTTP 400, invalid_value): Invalid size "512x512". The total pixel count must be at least 655360.',
    );
    expect((err as ProviderError).notCharged).toBe(true);
  });

  it("treats a 5xx as possibly charged", async () => {
    const err = await failure(
      provider(fakeFetch(() => new Response("upstream error", { status: 502 })).fetch).generate(request, signal),
    );
    expect(err.message).toBe("OpenAI returned a server error (HTTP 502). It may still have billed the request.");
    expect((err as ProviderError).notCharged).toBe(false);
  });

  it.each([
    ["ECONNREFUSED", true],
    ["ENOTFOUND", true],
    ["ECONNRESET", false],
  ])("classifies a %s network error (uncharged: %s)", async (code, notCharged) => {
    const fetchFn = () =>
      Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }));
    const err = await failure(provider(fetchFn).generate(request, signal));
    expect(err.message).toMatch(new RegExp(`^Can't reach OpenAI \\(${code}\\)\\.`));
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
      "OpenAI didn't finish within 0s (DARKROOM_OPENAI_TIMEOUT_MS). It may still have billed the request.",
    );
    expect((err as ProviderError).notCharged).toBe(false);
  });

  it("reports a timeout while reading the response body as a timeout", async () => {
    // Headers arrive, then the body stalls until the request's signal aborts it, as with real fetch.
    const stalls: typeof fetch = (_input, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () => {
                controller.error(init.signal?.reason);
              });
            },
          }),
          { status: 200 },
        ),
      );
    const err = await failure(provider(stalls, { timeoutMs: 20 }).generate(request, signal));
    expect(err.message).toMatch(/^OpenAI didn't finish within 0s \(DARKROOM_OPENAI_TIMEOUT_MS\)/);
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
    const { fetch, calls } = fakeFetch(reply("generations-200.json"));
    const err = await failure(provider(fetch).generate(request, AbortSignal.abort()));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("Cancelled before the request was sent to OpenAI.");
    expect((err as ProviderError).notCharged).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("openaiSize", () => {
  it.each(ASPECT_RATIOS.flatMap((ar) => QUALITIES.map((q) => [ar, q] as const)))(
    "%s %s meets the API's size rules",
    (aspectRatio, quality) => {
      const { width, height } = openaiSize(aspectRatio, quality);
      expect(width % 16).toBe(0);
      expect(height % 16).toBe(0);
      expect(width * height).toBeGreaterThanOrEqual(MIN_PIXELS);
      expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(3);
      const [w, h] = aspectRatio.split(":").map(Number) as [number, number];
      expect(width / height).toBeCloseTo(w / h, 1);
    },
  );

  it("keeps final at the shared 1MP sizes", () => {
    expect(openaiSize("1:1", "final")).toEqual({ width: 1024, height: 1024 });
    expect(openaiSize("16:9", "final")).toEqual({ width: 1360, height: 768 });
  });

  it("raises draft to the smallest allowed size", () => {
    expect(openaiSize("1:1", "draft")).toEqual({ width: 816, height: 816 });
  });
});

describe("costFromUsage", () => {
  const rates = { textInput: 5, imageInput: 8, imageOutput: 30 };

  it("uses the published gpt-image-2.5-flare rates", () => {
    expect(OPENAI_RATES["gpt-image-2.5-flare"]).toEqual(rates);
  });

  it("prices text input, image input, and output tokens separately", () => {
    const usage = { input_tokens: 300, output_tokens: 1000, input_tokens_details: { text_tokens: 100, image_tokens: 200 } };
    expect(costFromUsage(usage, rates)).toBe((100 * 5 + 200 * 8 + 1000 * 30) / 1e6);
  });

  it("prices undivided input at the image rate rather than under-count", () => {
    expect(costFromUsage({ input_tokens: 100, output_tokens: 0 }, rates)).toBe(0.0008);
  });

  it("prices input missing from a partial breakdown at the image rate", () => {
    expect(costFromUsage({ input_tokens: 50, output_tokens: 0, input_tokens_details: {} }, rates)).toBe(0.0004);
    expect(
      costFromUsage({ input_tokens: 50, output_tokens: 0, input_tokens_details: { text_tokens: 20 } }, rates),
    ).toBe((20 * 5 + 30 * 8) / 1e6);
  });

  it("returns undefined without usage", () => {
    expect(costFromUsage(undefined, rates)).toBeUndefined();
    expect(costFromUsage({ input_tokens: 10 }, rates)).toBeUndefined();
  });
});

describe("redactKey", () => {
  it("removes the key and anything shaped like an OpenAI key", () => {
    expect(redactKey(`bad key ${KEY}`, KEY)).toBe("bad key [redacted]");
    expect(redactKey("Incorrect API key provided: sk-proj-abcd****wxyz.", undefined)).toBe(
      "Incorrect API key provided: sk-[redacted].",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(redactKey("task-runner is fine", "x")).toBe("task-runner is fine");
  });
});
