import sharp from "sharp";
import { ConfigError } from "../config.js";
import { sizeForArea, QUALITY_PIXELS } from "./sizes.js";
import {
  ContentRefusedError,
  ProviderError,
  type AspectRatio,
  type GenerateRequest,
  type GenerateResult,
  type ImageProvider,
  type ProgressListener,
  type Quality,
} from "./types.js";

// OpenAI Images API (POST /v1/images/generations) with a gpt-image model. Paid:
// billed by tokens, so the result carries the actual cost from `usage`.

const ENDPOINT = "https://api.openai.com/v1/images/generations";

// USD per 1M tokens, from developers.openai.com/api/docs/pricing (checked Oct 2, 2026).
// Only models that accept arbitrary sizes are listed; adding one is one line.
interface Rates {
  textInput: number;
  imageInput: number;
  imageOutput: number;
}
export const OPENAI_RATES: Record<string, Rates> = {
  "gpt-image-2.5-flare": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "gpt-image-2.5-sunburst": { textInput: 5, imageInput: 8, imageOutput: 30 },
  "gpt-image-2": { textInput: 5, imageInput: 8, imageOutput: 30 },
};

// Image output tokens per tier, for the up-front estimate the ledger reserves against
// the cap; settling replaces it with the actual cost. From the M2 benchmark (Oct 2,
// 2026, gpt-image-2.5-flare): tokens don't follow pixel count, and a square is the most
// expensive shape (low: 171 at 1:1, ~117 at 3:2; high: 1,756 at 1:1, 987 at 16:9).
// draft is the measured square count plus ~25%. final (medium): a 3:2 measured ~290
// tokens ($0.0089), so a square is ~425 (third-party counts say ~439); 700 leaves
// extra room. The router warns if an actual cost beats its estimate.
const ESTIMATED_OUTPUT_TOKENS: Record<Quality, number> = { draft: 215, final: 700 };

// Prompt text tokens: the benchmark prompt ran ~3.4 characters per token; 3 errs high.
const estimatePromptTokens = (prompt: string) => Math.ceil(prompt.length / 3) + 20;

// The API requires at least this many pixels (1024×640), so "draft" can't be the
// usual 0.25MP: it renders at the smallest allowed size and at low quality instead.
export const MIN_PIXELS = 655_360;

// "high" costs ~4x "medium" for little visible gain in the M2 benchmark (Matt's call, Oct 2, 2026).
type OpenAIQuality = "low" | "medium";
const QUALITY: Record<Quality, OpenAIQuality> = { draft: "low", final: "medium" };

/** The size OpenAI renders a tier at: our pixel budget, raised to the API's minimum, in multiples of 16. */
export function openaiSize(aspectRatio: AspectRatio, quality: Quality): { width: number; height: number } {
  let pixels = Math.max(QUALITY_PIXELS[quality], MIN_PIXELS);
  for (;;) {
    const size = sizeForArea(aspectRatio, pixels);
    if (size.width * size.height >= MIN_PIXELS) return size;
    pixels += 16 * 16; // rounding to multiples of 16 can land just under the minimum
  }
}

export interface OpenAIOptions {
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export function createOpenAIProvider(opts: OpenAIOptions): ImageProvider {
  const { apiKey, model, timeoutMs } = opts;
  const modelRates = OPENAI_RATES[model];
  if (!modelRates) {
    throw new ConfigError([
      `DARKROOM_OPENAI_MODEL: "${model}" isn't a model Darkroom has prices for; use one of: ${Object.keys(OPENAI_RATES).join(", ")}`,
    ]);
  }
  const rates: Rates = modelRates;
  const fetchFn = opts.fetch ?? fetch;
  const redact = (text: string) => redactKey(text, apiKey);

  function estimateCostUsd(req: GenerateRequest): number {
    const promptTokens = estimatePromptTokens(req.prompt);
    return roundUsd((promptTokens * rates.textInput + ESTIMATED_OUTPUT_TOKENS[req.quality] * rates.imageOutput) / 1e6);
  }

  return {
    name: "openai",
    isPaid: true,
    supports: { negativePrompt: false, seed: false },
    estimateCostUsd,

    // Free and offline, per the spec: a paid provider is healthy when it has its key.
    healthCheck() {
      if (apiKey) return Promise.resolve({ ok: true });
      return Promise.resolve({
        ok: false,
        detail:
          "DARKROOM_OPENAI_API_KEY is not set. Darkroom ignores a generic OPENAI_API_KEY on purpose, so a key in your shell never spends money by itself",
      });
    },

    async generate(req: GenerateRequest, signal: AbortSignal, onProgress?: ProgressListener): Promise<GenerateResult> {
      if (!apiKey) throw new ProviderError("DARKROOM_OPENAI_API_KEY is not set.", { notCharged: true });
      try {
        signal.throwIfAborted();
      } catch {
        // Not a bare AbortError: the router keeps the reservation for those, and nothing was sent yet.
        throw new ProviderError("Cancelled before the request was sent to OpenAI.", { notCharged: true });
      }
      const { width, height } = openaiSize(req.aspectRatio, req.quality);
      const quality = QUALITY[req.quality];
      onProgress?.({ message: `Waiting for OpenAI (${model}, ${quality} quality, ${width}×${height})` });

      const timeout = AbortSignal.timeout(timeoutMs);
      // The body is read under the same signal, so a cancel or timeout mid-download
      // lands in the same handler as one during the request.
      let res: Response | undefined;
      let text: string;
      try {
        res = await fetchFn(ENDPOINT, {
          method: "POST",
          signal: AbortSignal.any([signal, timeout]),
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: req.prompt,
            n: 1,
            size: `${width}x${height}`,
            quality,
            output_format: "png",
          }),
        });
        text = await res.text();
      } catch (err) {
        if (signal.aborted) throw err;
        if (timeout.aborted) {
          throw new ProviderError(
            `OpenAI didn't finish within ${Math.round(timeoutMs / 1000)}s (DARKROOM_OPENAI_TIMEOUT_MS). It may still have billed the request.`,
          );
        }
        // An error status whose body couldn't be read is still that error status.
        if (res && !res.ok) throw describeHttpError(res.status, "", redact);
        throw networkError(err, redact);
      }
      if (!res.ok) throw describeHttpError(res.status, text, redact);

      let body: ImagesResponse;
      try {
        body = JSON.parse(text) as ImagesResponse;
      } catch {
        throw new ProviderError(`OpenAI returned HTTP ${res.status} with a body that isn't JSON.`);
      }
      const b64 = body.data?.[0]?.b64_json;
      if (typeof b64 !== "string" || b64 === "") throw new ProviderError("OpenAI's response had no image in it.");

      const raw = Buffer.from(b64, "base64");
      const image = sharp(raw);
      const meta = await image.metadata().catch(() => undefined);
      if (!meta?.width || !meta.height) throw new ProviderError("OpenAI returned image data that couldn't be decoded.");
      const png = meta.format === "png" ? raw : await image.png().toBuffer();

      const actualCostUsd = costFromUsage(body.usage, rates);
      return {
        png,
        model,
        width: meta.width,
        height: meta.height,
        seed: null,
        ...(actualCostUsd !== undefined && { actualCostUsd }),
      };
    },
  };
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
}

interface ImagesResponse {
  data?: { b64_json?: string }[];
  usage?: Usage;
}

interface ErrorBody {
  error?: {
    message?: string;
    code?: string | null;
    type?: string;
    moderation_details?: { moderation_stage?: string; categories?: string[] };
  };
}

/** Actual cost from the response's token counts; undefined when usage is missing. */
export function costFromUsage(usage: Usage | undefined, rates: Rates): number | undefined {
  if (typeof usage?.input_tokens !== "number" || typeof usage.output_tokens !== "number") return undefined;
  const textIn = usage.input_tokens_details?.text_tokens ?? 0;
  // Input the breakdown doesn't account for (or all of it, without one) is billed
  // at the higher image rate rather than under-counted.
  const imageIn = Math.max(0, usage.input_tokens - textIn);
  return roundUsd((textIn * rates.textInput + imageIn * rates.imageInput + usage.output_tokens * rates.imageOutput) / 1e6);
}

function describeHttpError(status: number, text: string, redact: (s: string) => string): ProviderError {
  let body: ErrorBody = {};
  try {
    body = JSON.parse(text) as ErrorBody;
  } catch {
    // not JSON; fall through with the status alone
  }
  const err = body.error;
  const detail = err?.message ? `: ${redact(err.message)}` : "";

  if (err?.code === "moderation_blocked") {
    const stage = err.moderation_details?.moderation_stage ?? "unknown";
    const categories = err.moderation_details?.categories?.join(", ");
    // A block on the prompt happens before generation; one on the output may have been billed.
    return new ContentRefusedError(
      `OpenAI's moderation blocked this request (${stage} check${categories ? `; ${categories}` : ""})`,
      { notCharged: stage === "input" },
    );
  }
  if (status === 401) {
    return new ProviderError(`OpenAI rejected the API key (HTTP 401). Check DARKROOM_OPENAI_API_KEY${detail}`, {
      notCharged: true,
    });
  }
  // 4xx responses reject the request before any image is made; 5xx may come after.
  if (status >= 400 && status < 500) {
    return new ProviderError(`OpenAI rejected the request (HTTP ${status}${err?.code ? `, ${err.code}` : ""})${detail}`, {
      notCharged: true,
    });
  }
  return new ProviderError(`OpenAI returned a server error (HTTP ${status})${detail}. It may still have billed the request.`);
}

// Errors where the request never reached OpenAI, so it can't have been billed.
const UNSENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);

function networkError(err: unknown, redact: (s: string) => string): ProviderError {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : undefined;
  const code = cause && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  const reason = redact(code ?? cause?.message ?? (err instanceof Error ? err.message : String(err)));
  const unsent = code !== undefined && UNSENT_CODES.has(code);
  return new ProviderError(
    `Can't reach OpenAI (${reason}).${unsent ? "" : " It may still have billed the request."}`,
    { notCharged: unsent },
  );
}

/** Removes the API key, and anything shaped like an OpenAI key, from text bound for logs or Claude. */
export function redactKey(text: string, apiKey: string | undefined): string {
  // A very short "key" would mangle ordinary text; real keys are far longer.
  let out = apiKey && apiKey.length >= 8 ? text.split(apiKey).join("[redacted]") : text;
  out = out.replace(/sk-[A-Za-z0-9_*-]{8,}/g, "sk-[redacted]");
  return out;
}

function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}
