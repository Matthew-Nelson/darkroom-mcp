import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PROVIDER_NAMES } from "../config.js";
import { log } from "../log.js";
import {
  ASPECT_RATIOS,
  ContentRefusedError,
  QUALITIES,
  type GenerateRequest,
  type ProgressListener,
} from "../providers/types.js";
import { NoProviderError, type Router } from "../router.js";
import { makePreview, slugify, type SavedImage, type Storage } from "../storage.js";

export const MAX_PROMPT_LENGTH = 4000;
export const HEARTBEAT_MS = 5000;

const DESCRIPTION = `Generate an image from a text prompt, save it as a PNG with a JSON metadata sidecar, and return a viewable preview plus the saved file path.

Use this when the user wants an image: an illustration, icon, photo, mockup, diagram-style picture, and so on. Look at the returned preview and refine the prompt if it misses what the user asked for.

By default this runs on a free local model. Local generation is slow (minutes, not seconds: about 1.5 minutes for "draft", 3 to 4 minutes for "final"), so iterate with quality "draft" and render "final" only once the composition is right, passing the draft's seed. With the default local model a new seed gives nearly the same picture, so to explore variations, reword the prompt instead of changing the seed.

Only pass "provider" when the user explicitly asks for a specific provider, because some providers cost money. Otherwise leave it out and the configured default is used.`;

const inputSchema = {
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(MAX_PROMPT_LENGTH)
    .describe("What to draw. Be specific about subject, composition, style, lighting, and any text to render."),
  negative_prompt: z
    .string()
    .max(MAX_PROMPT_LENGTH)
    .optional()
    .describe("Things to avoid. Ignored by providers that don't support it (reported in ignored_params)."),
  aspect_ratio: z.enum(ASPECT_RATIOS).default("1:1").describe("Output shape. The result reports the actual pixel size."),
  quality: z
    .enum(QUALITIES)
    .default("draft")
    .describe('"draft" (~0.25 megapixels, e.g. 512x512; faster) for iterating; "final" (~1 megapixel, e.g. 1024x1024) once the composition is right.'),
  provider: z
    .enum(PROVIDER_NAMES)
    .optional()
    .describe("Only set when the user explicitly asks for this provider. Some providers cost money."),
  seed: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe("Reuse a previous result's seed to keep its composition, e.g. when rendering a draft as final."),
  filename: z
    .string()
    .max(200)
    .optional()
    .describe("Base name for the saved file. It is sanitized and a unique suffix is always added."),
};

const outputSchema = {
  path: z.string().describe("Absolute path of the saved PNG"),
  sidecar_path: z.string().describe("Absolute path of the JSON metadata sidecar"),
  provider: z.string(),
  model: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  seed: z.number().int().nullable().describe("null when the provider has no seed control"),
  latency_ms: z.number().int(),
  cost_usd: z.number(),
  cost_is_estimate: z.boolean().describe("true when the provider did not report an actual cost"),
  ignored_params: z.array(z.string()).describe("Parameters the provider could not honor"),
  skipped_providers: z
    .array(z.object({ provider: z.string(), reason: z.string() }))
    .describe("Providers passed over before the one that served the request, and why"),
};

type Output = { [K in keyof typeof outputSchema]: z.infer<(typeof outputSchema)[K]> };

export function registerGenerateImage(server: McpServer, deps: { router: Router; storage: Storage }): void {
  server.registerTool(
    "generate_image",
    {
      title: "Generate image",
      description: DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra): Promise<CallToolResult> => {
      const req: GenerateRequest = {
        prompt: args.prompt,
        aspectRatio: args.aspect_ratio,
        quality: args.quality,
        ...(args.negative_prompt !== undefined && { negativePrompt: args.negative_prompt }),
        ...(args.seed !== undefined && { seed: args.seed }),
      };

      const started = performance.now();
      const progress = startProgress(extra);
      try {
        const { provider, result, skipped } = await deps.router.generate(req, {
          provider: args.provider,
          signal: extra.signal,
          ...(progress && { onProgress: progress.update }),
        });
        const latencyMs = Math.round(performance.now() - started);

        const ignored: string[] = [];
        if (args.negative_prompt !== undefined && !provider.supports.negativePrompt) ignored.push("negative_prompt");
        if (args.seed !== undefined && !provider.supports.seed) ignored.push("seed");

        const costUsd = result.actualCostUsd ?? provider.estimateCostUsd(req);
        const facts = {
          provider: provider.name,
          model: result.model,
          width: result.width,
          height: result.height,
          seed: result.seed,
          latency_ms: latencyMs,
          cost_usd: costUsd,
          cost_is_estimate: result.actualCostUsd === undefined,
          ignored_params: ignored,
          skipped_providers: skipped,
        };
        const name = args.filename ?? args.prompt;
        let saved: SavedImage;
        try {
          saved = await deps.storage.save(name, result.png, {
            version: 1,
            created_at: new Date().toISOString(),
            request: args,
            ...facts,
          });
        } catch (err) {
          // The image may have been paid for: never drop it on the floor.
          return await rescueResult(err, result.png, name, facts, deps.storage.root);
        }
        const output: Output = { path: saved.pngPath, sidecar_path: saved.sidecarPath, ...facts };
        const preview = await makePreview(result.png);

        log("info", "generated image", {
          provider: provider.name,
          latency_ms: latencyMs,
          path: saved.pngPath,
          progress_notifications: progress !== undefined,
        });
        return {
          content: [
            { type: "image", data: preview.jpeg.toString("base64"), mimeType: "image/jpeg" },
            { type: "text", text: `${summarize(output)}\n\n${JSON.stringify(output)}` },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return errorResult(err);
      } finally {
        progress?.stop();
      }
    },
  );
}

/**
 * Sends MCP progress notifications while a provider works, if the client asked
 * for them (sent a progressToken). Provider updates go out as they happen, and a
 * heartbeat repeats the latest one so clients with idle timeouts keep waiting.
 * `progress` is elapsed seconds: the spec requires it to increase on every
 * notification, and no provider knows the total time up front.
 */
function startProgress(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): { update: ProgressListener; stop: () => void } | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  const started = performance.now();
  let last = 0;
  let message = "Starting";

  const send = () => {
    const elapsed = (performance.now() - started) / 1000;
    last = Math.max(Math.round(elapsed * 10) / 10, last + 0.1);
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: last, message: `${message} (${Math.round(elapsed)}s)` },
      })
      .catch(() => undefined); // the client may have gone away; generation carries on
  };
  const timer = setInterval(send, HEARTBEAT_MS);
  timer.unref();
  return {
    update(update) {
      message = update.message;
      send();
    },
    stop: () => {
      clearInterval(timer);
    },
  };
}

function formatCost(o: { cost_usd: number; cost_is_estimate: boolean }): string {
  return `$${o.cost_usd.toFixed(o.cost_usd === 0 ? 2 : 4)}${o.cost_is_estimate && o.cost_usd > 0 ? " (estimate)" : ""}`;
}

/**
 * Saving failed after the provider succeeded. Keeps the PNG in the system temp
 * folder and says where, so a paid image is never lost to a disk problem.
 */
async function rescueResult(
  err: unknown,
  png: Buffer,
  name: string,
  facts: { provider: string; cost_usd: number; cost_is_estimate: boolean },
  outputDir: string,
): Promise<CallToolResult> {
  const reason = err instanceof Error ? err.message : String(err);
  const path = join(tmpdir(), `darkroom-rescue-${slugify(name)}-${randomBytes(4).toString("hex")}.png`);
  const kept = await writeFile(path, png, { flag: "wx" }).then(
    () => `The image was kept at ${path} instead.`,
    (e: unknown) => `Keeping a copy in the temp folder failed too (${e instanceof Error ? e.message : String(e)}).`,
  );
  const text = `Generated an image with ${facts.provider} (${formatCost(facts)}), but couldn't save it to ${outputDir} (${reason}). ${kept}`;
  log("error", "could not save generated image", { error: reason, rescued: kept });
  return { isError: true, content: [{ type: "text", text }] };
}

function summarize(o: Output): string {
  const cost = formatCost(o);
  const lines = [
    `Saved ${o.path}`,
    `${o.provider} (${o.model}), ${o.width}×${o.height}, seed ${o.seed ?? "n/a"}, ${(o.latency_ms / 1000).toFixed(1)}s, ${cost}. The image above is a preview.`,
  ];
  if (o.ignored_params.length > 0) lines.push(`Ignored by this provider: ${o.ignored_params.join(", ")}.`);
  for (const s of o.skipped_providers) lines.push(`Skipped ${s.provider}: ${s.reason}.`);
  return lines.join("\n");
}

function errorResult(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof ContentRefusedError) {
    text = `The provider refused this prompt: ${err.message}. Rephrase the request; Darkroom does not retry refused prompts on another provider.`;
  } else if (err instanceof NoProviderError) {
    text = err.message;
  } else {
    text = `Image generation failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  log("warn", "generate_image failed", { error: text });
  return { isError: true, content: [{ type: "text", text }] };
}
