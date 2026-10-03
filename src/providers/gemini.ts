import { randomInt } from "node:crypto";
import sharp from "sharp";
import { ConfigError } from "../config.js";
import { networkError, redactKey, roundUsd } from "./paid-api.js";
import {
  ContentRefusedError,
  ProviderError,
  type GenerateRequest,
  type GenerateResult,
  type ImageProvider,
  type ProgressListener,
  type Quality,
} from "./types.js";

// Gemini API (POST /v1beta/models/{model}:generateContent) with a Flash Image model.
// Paid: billed by tokens, so the result carries the actual cost from `usageMetadata`.
// generateContent rather than the newer Interactions API: Google recommends it for
// stable deployments, and it's stateless (Interactions stores each request by default).

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// USD per 1M tokens, from ai.google.dev/gemini-api/docs/pricing (checked Oct 3, 2026).
// Thinking is billed as text output. `draftSize` is the smallest size the model renders:
// Flash Lite only does 1K, so its drafts cost the same as its finals.
type ImageSize = "512" | "1K";
interface Model {
  input: number;
  textOutput: number;
  imageOutput: number;
  draftSize: ImageSize;
}
export const GEMINI_MODELS: Record<string, Model> = {
  "gemini-3.1-flash-image": { input: 0.5, textOutput: 3, imageOutput: 60, draftSize: "512" },
  "gemini-3.1-flash-lite-image": { input: 0.25, textOutput: 1.5, imageOutput: 30, draftSize: "1K" },
};

// Image output tokens per size, from the pricing page: a flat count at each size,
// whatever the aspect ratio.
const IMAGE_TOKENS: Record<ImageSize, number> = { "512": 747, "1K": 1120 };

// Output beyond the image itself. In the M5 benchmark (Oct 3, 2026) every response
// reported 414–482 more output tokens than its IMAGE count, with no modality and no
// thoughtsTokenCount; that's taken to be thinking (which can't be turned off), billed as
// text output. Measured costs were within 1% of list price, which supports that reading.
const ESTIMATED_EXTRA_OUTPUT_TOKENS = 600;

// generationConfig.seed is a 32-bit signed integer.
const MAX_SEED = 2 ** 31 - 1;

// Prompt text tokens: errs high, as for OpenAI.
const estimatePromptTokens = (prompt: string) => Math.ceil(prompt.length / 3) + 20;

// A candidate that stopped for one of these is a policy refusal, not a failure.
const REFUSAL_REASONS = new Set([
  "SAFETY",
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "IMAGE_PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
  "IMAGE_RECITATION",
]);

export interface GeminiOptions {
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export function geminiImageSize(model: string, quality: Quality): ImageSize {
  return quality === "draft" ? (GEMINI_MODELS[model]?.draftSize ?? "1K") : "1K";
}

export function createGeminiProvider(opts: GeminiOptions): ImageProvider {
  const { apiKey, model, timeoutMs } = opts;
  const modelRates = GEMINI_MODELS[model];
  if (!modelRates) {
    throw new ConfigError([
      `DARKROOM_GEMINI_MODEL: "${model}" isn't a model Darkroom has prices for; use one of: ${Object.keys(GEMINI_MODELS).join(", ")}`,
    ]);
  }
  const rates: Model = modelRates;
  const fetchFn = opts.fetch ?? fetch;
  const redact = (text: string) => redactKey(text, apiKey);

  function estimateCostUsd(req: GenerateRequest): number {
    const imageTokens = IMAGE_TOKENS[geminiImageSize(model, req.quality)];
    return roundUsd(
      (estimatePromptTokens(req.prompt) * rates.input +
        imageTokens * rates.imageOutput +
        ESTIMATED_EXTRA_OUTPUT_TOKENS * rates.textOutput) /
        1e6,
    );
  }

  return {
    name: "gemini",
    model,
    isPaid: true,
    // Not exact: the same seed gives the same composition, slightly reframed, and it
    // carries from a 512px draft to a 1K final (M5 benchmark).
    supports: { negativePrompt: false, seed: true },
    estimateCostUsd,

    // Free and offline, per the spec: a paid provider is healthy when it has its key.
    healthCheck() {
      if (apiKey) return Promise.resolve({ ok: true });
      return Promise.resolve({
        ok: false,
        detail:
          "DARKROOM_GEMINI_API_KEY is not set. Darkroom ignores a generic GEMINI_API_KEY or GOOGLE_API_KEY on purpose, so a key in your shell never spends money by itself",
      });
    },

    async generate(req: GenerateRequest, signal: AbortSignal, onProgress?: ProgressListener): Promise<GenerateResult> {
      if (!apiKey) throw new ProviderError("DARKROOM_GEMINI_API_KEY is not set.", { notCharged: true });
      try {
        signal.throwIfAborted();
      } catch {
        // Not a bare AbortError: the router keeps the reservation for those, and nothing was sent yet.
        throw new ProviderError("Cancelled before the request was sent to Gemini.", { notCharged: true });
      }
      if (req.seed !== undefined && req.seed > MAX_SEED) {
        throw new ProviderError(
          `Gemini seeds go up to ${MAX_SEED}, and this one is ${req.seed} (perhaps from another provider). Use a smaller seed, or none.`,
          { notCharged: true },
        );
      }
      const seed = req.seed ?? randomInt(0, MAX_SEED + 1);
      const imageSize = geminiImageSize(model, req.quality);
      const sizeLabel = imageSize === "512" ? "512px" : imageSize;
      onProgress?.({ message: `Waiting for Gemini (${model}, ${sizeLabel}, ${req.aspectRatio})` });

      const timeout = AbortSignal.timeout(timeoutMs);
      // The body is read under the same signal, so a cancel or timeout mid-download
      // lands in the same handler as one during the request.
      let res: Response | undefined;
      let text: string;
      try {
        res = await fetchFn(`${ENDPOINT}/${model}:generateContent`, {
          method: "POST",
          signal: AbortSignal.any([signal, timeout]),
          // In a header, never a ?key= query parameter, so it can't leak through a URL in an error.
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: req.prompt }] }],
            generationConfig: {
              responseModalities: ["IMAGE"],
              seed,
              imageConfig: { aspectRatio: req.aspectRatio, imageSize },
            },
          }),
        });
        text = await res.text();
      } catch (err) {
        if (signal.aborted) throw err;
        if (timeout.aborted) {
          throw new ProviderError(
            `Gemini didn't finish within ${Math.round(timeoutMs / 1000)}s (DARKROOM_GEMINI_TIMEOUT_MS). It may still have billed the request.`,
          );
        }
        // An error status whose body couldn't be read is still that error status.
        if (res && !res.ok) throw describeHttpError(res.status, "", redact);
        throw networkError("Gemini", err, redact);
      }
      if (!res.ok) throw describeHttpError(res.status, text, redact);

      let body: GenerateContentResponse;
      try {
        body = JSON.parse(text) as GenerateContentResponse;
      } catch {
        throw new ProviderError(`Gemini returned HTTP ${res.status} with a body that isn't JSON.`);
      }

      const blockReason = body.promptFeedback?.blockReason;
      if (blockReason) {
        // The prompt was refused before any generation, so no output was billed.
        throw new ContentRefusedError(`Gemini blocked this prompt (${blockReason})`, { notCharged: true });
      }
      const candidate = body.candidates?.[0];
      const finishReason = candidate?.finishReason;
      if (finishReason && REFUSAL_REASONS.has(finishReason)) {
        throw new ContentRefusedError(`Gemini refused to finish this image (${finishReason})`);
      }

      // Thinking can produce up to two interim images; the final one isn't marked as a thought.
      const parts = candidate?.content?.parts ?? [];
      const image = parts
        .filter((p) => !p.thought && p.inlineData?.mimeType?.startsWith("image/") && p.inlineData.data)
        .at(-1);
      if (!image?.inlineData?.data) {
        const said = parts
          .filter((p) => !p.thought && typeof p.text === "string")
          .map((p) => p.text)
          .join(" ")
          .trim();
        const why = finishReason && finishReason !== "STOP" ? ` (${finishReason})` : "";
        throw new ProviderError(
          `Gemini's response had no image in it${why}${said ? `. It said: "${redact(truncate(said, 300))}"` : "."}`,
        );
      }

      const raw = Buffer.from(image.inlineData.data, "base64");
      const decoded = sharp(raw);
      const meta = await decoded.metadata().catch(() => undefined);
      if (!meta?.width || !meta.height) throw new ProviderError("Gemini returned image data that couldn't be decoded.");
      const png = meta.format === "png" ? raw : await decoded.png().toBuffer();

      const actualCostUsd = costFromUsage(body.usageMetadata, rates);
      return {
        png,
        model,
        width: meta.width,
        height: meta.height,
        seed,
        ...(actualCostUsd !== undefined && { actualCostUsd }),
      };
    },
  };
}

interface Part {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
}

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  candidatesTokensDetails?: { modality?: string; tokenCount?: number }[];
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: UsageMetadata;
}

interface ErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { "@type"?: string; reason?: string }[];
  };
}

/** Actual cost from the response's token counts; undefined when usage is missing. */
export function costFromUsage(usage: UsageMetadata | undefined, rates: Model): number | undefined {
  if (typeof usage?.promptTokenCount !== "number" || typeof usage.candidatesTokenCount !== "number") return undefined;
  const imageEntries = (usage.candidatesTokensDetails ?? []).filter((d) => d.modality === "IMAGE");
  const imageTokens = imageEntries.reduce((sum, d) => sum + (d.tokenCount ?? 0), 0);
  // With an IMAGE count, the rest of the output is priced at the text and thinking
  // rate: real responses carry 414–482 unlabeled tokens beyond the image (see
  // ESTIMATED_EXTRA_OUTPUT_TOKENS). With no IMAGE count to go on, all of it is priced
  // at the image rate, so the ledger over-counts rather than under-counts.
  const textTokens = imageEntries.length === 0 ? 0 : Math.max(0, usage.candidatesTokenCount - imageTokens);
  const imageOut = usage.candidatesTokenCount - textTokens;
  const thoughts = usage.thoughtsTokenCount ?? 0;
  const usd =
    usage.promptTokenCount * rates.input + imageOut * rates.imageOutput + (textTokens + thoughts) * rates.textOutput;
  return roundUsd(usd / 1e6);
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
  const reasons = new Set((err?.details ?? []).map((d) => d.reason));

  // Gemini answers a bad key with HTTP 400, not 401.
  if (reasons.has("API_KEY_INVALID") || status === 401) {
    return new ProviderError(`Gemini rejected the API key (HTTP ${status}). Check DARKROOM_GEMINI_API_KEY${detail}`, {
      notCharged: true,
    });
  }
  if (status === 403) {
    return new ProviderError(
      `Gemini refused access (HTTP 403). Check that the key's project has the Gemini API enabled${detail}`,
      { notCharged: true },
    );
  }
  if (status === 429) {
    return new ProviderError(
      `Gemini's rate limit or quota was hit (HTTP 429). Image models have no free tier, so the key's project needs billing turned on${detail}`,
      { notCharged: true },
    );
  }
  // 4xx responses reject the request before any image is made; 5xx may come after.
  if (status >= 400 && status < 500) {
    return new ProviderError(`Gemini rejected the request (HTTP ${status}${err?.status ? `, ${err.status}` : ""})${detail}`, {
      notCharged: true,
    });
  }
  return new ProviderError(`Gemini returned a server error (HTTP ${status})${detail}. It may still have billed the request.`);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
