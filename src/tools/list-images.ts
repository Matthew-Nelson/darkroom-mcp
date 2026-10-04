import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PROVIDER_NAMES, type ProviderName } from "../config.js";
import { formatUsd } from "../ledger.js";
import { log } from "../log.js";
import { isErrno, SIDECAR_NAME, type Storage } from "../storage.js";

const DESCRIPTION = `List recently generated images, newest first, from the metadata saved next to each one: file path, prompt, provider, model, size, seed, cost, and alt text (if saved with save_alt_text).

Use this when the user refers to an earlier image ("the lighthouse from before") or asks what has been generated. To render an earlier draft as final, pass its prompt and seed back to generate_image. It reads files only; it generates nothing and costs nothing.`;

// Files are read a few at a time, so a big folder can't exhaust file handles.
const READ_BATCH = 64;

// The fields listed; anything else in the sidecar is ignored.
const sidecarSchema = z.object({
  created_at: z.string(),
  request: z.object({ prompt: z.string(), aspect_ratio: z.string(), quality: z.string() }),
  provider: z.string(),
  model: z.string(),
  width: z.number(),
  height: z.number(),
  seed: z.number().nullable(),
  cost_usd: z.number(),
  // A hand-edited alt_text that isn't a string is dropped rather than hiding the image.
  alt_text: z.string().optional().catch(undefined),
});

const imageSchema = z.object({
  path: z.string().describe("Absolute path of the PNG"),
  sidecar_path: z.string(),
  created_at: z.string(),
  prompt: z.string(),
  provider: z.string(),
  model: z.string(),
  quality: z.string(),
  aspect_ratio: z.string(),
  width: z.number(),
  height: z.number(),
  seed: z.number().nullable(),
  cost_usd: z.number(),
  alt_text: z.string().nullable().describe("null until alt text is saved with save_alt_text"),
});

const outputSchema = {
  images: z.array(imageSchema).describe("Newest first"),
  total: z.number().int().describe("Images matching the filter, before the limit"),
  unreadable: z
    .number()
    .int()
    .describe("Sidecars skipped because they couldn't be read or parsed, or their PNG is gone (read errors are logged)"),
};

type Output = { [K in keyof typeof outputSchema]: z.infer<(typeof outputSchema)[K]> };
type Image = z.infer<typeof imageSchema>;

export async function listImages(root: string, opts: { limit: number; provider?: ProviderName | undefined }): Promise<Output> {
  // Only names save() writes: skips the spend ledger, temp files, and anything save_alt_text or check_contrast would refuse.
  const names = (await readdir(root)).filter((name) => SIDECAR_NAME.test(name));
  const read = await inBatches(names, (name) => readImage(root, name));
  const images = read.filter((i): i is Image => i !== undefined);
  const matching = images
    .filter((i) => opts.provider === undefined || i.provider === opts.provider)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.path.localeCompare(a.path));
  return { images: matching.slice(0, opts.limit), total: matching.length, unreadable: read.length - images.length };
}

async function readImage(root: string, sidecarName: string): Promise<Image | undefined> {
  const sidecarPath = join(root, sidecarName);
  // The PNG path comes from the sidecar's own name, never its contents, so an edited
  // sidecar can't point outside the output folder.
  const path = sidecarPath.replace(/\.json$/, ".png");
  let sidecar: unknown;
  try {
    sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    if (!(await stat(path)).isFile()) return undefined;
  } catch (err) {
    // A broken sidecar or a deleted PNG is routine; anything else (permissions,
    // a folder named like a sidecar, I/O errors) is worth a line on stderr.
    if (!(err instanceof SyntaxError || isErrno(err, "ENOENT"))) {
      log("warn", "couldn't read image sidecar", { path: sidecarPath, error: err instanceof Error ? err.message : String(err) });
    }
    return undefined;
  }
  const parsed = sidecarSchema.safeParse(sidecar);
  if (!parsed.success) return undefined;
  const s = parsed.data;
  return {
    path,
    sidecar_path: sidecarPath,
    created_at: s.created_at,
    prompt: s.request.prompt,
    provider: s.provider,
    model: s.model,
    quality: s.request.quality,
    aspect_ratio: s.request.aspect_ratio,
    width: s.width,
    height: s.height,
    seed: s.seed,
    cost_usd: s.cost_usd,
    alt_text: s.alt_text ?? null,
  };
}

async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += READ_BATCH) {
    out.push(...(await Promise.all(items.slice(i, i + READ_BATCH).map(fn))));
  }
  return out;
}

export function registerListImages(server: McpServer, deps: { storage: Storage }): void {
  server.registerTool(
    "list_images",
    {
      title: "List generated images",
      description: DESCRIPTION,
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe("How many images to return, newest first"),
        provider: z.enum(PROVIDER_NAMES).optional().describe("Only images made by this provider"),
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const out = await listImages(deps.storage.root, args);
        return {
          content: [{ type: "text", text: `${summarize(out)}\n\n${JSON.stringify(out)}` }],
          structuredContent: out,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `Couldn't list images in ${deps.storage.root}: ${reason}` }] };
      }
    },
  );
}

function summarize(o: Output): string {
  const lines = [
    o.total === 0 ? "No images found." : `Showing ${o.images.length} of ${o.total} images, newest first.`,
  ];
  for (const i of o.images) {
    lines.push(`${i.created_at} · ${i.provider} · ${i.width}×${i.height} · ${formatUsd(i.cost_usd)} · ${i.path}\n  ${i.prompt}`);
    if (i.alt_text !== null) lines.push(`  Alt text: ${i.alt_text}`);
  }
  if (o.unreadable > 0) lines.push(`Skipped ${o.unreadable} unreadable sidecar(s).`);
  return lines.join("\n");
}
