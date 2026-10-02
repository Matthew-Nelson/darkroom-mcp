import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PROVIDER_NAMES } from "../config.js";
import { log } from "../log.js";
import { ASPECT_RATIOS, ContentRefusedError, QUALITIES, type GenerateRequest } from "../providers/types.js";
import { NoProviderError, type Router } from "../router.js";
import { makePreview, type Storage } from "../storage.js";

export const MAX_PROMPT_LENGTH = 4000;

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
    .describe('"draft" (~512px short edge, faster) for iterating; "final" (~1024px) once the composition is right.'),
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
      try {
        const { provider, result, skipped } = await deps.router.generate(req, {
          provider: args.provider,
          signal: extra.signal,
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
        const saved = await deps.storage.save(args.filename ?? args.prompt, result.png, {
          version: 1,
          created_at: new Date().toISOString(),
          request: args,
          ...facts,
        });
        const output: Output = { path: saved.pngPath, sidecar_path: saved.sidecarPath, ...facts };
        const preview = await makePreview(result.png);

        log("info", "generated image", { provider: provider.name, latency_ms: latencyMs, path: saved.pngPath });
        return {
          content: [
            { type: "image", data: preview.jpeg.toString("base64"), mimeType: "image/jpeg" },
            { type: "text", text: `${summarize(output)}\n\n${JSON.stringify(output)}` },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

function summarize(o: Output): string {
  const cost = `$${o.cost_usd.toFixed(o.cost_usd === 0 ? 2 : 4)}${o.cost_is_estimate && o.cost_usd > 0 ? " (estimate)" : ""}`;
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
