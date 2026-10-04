import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { log } from "../log.js";
import { StorageError, type Storage } from "../storage.js";

export const MAX_ALT_TEXT_LENGTH = 1000;

const DESCRIPTION = `Save alt text for a generated image into its metadata sidecar, replacing any earlier alt text. list_images returns it afterwards.

Use this after you have looked at the image, when it will go into a page, app, or document. Describe what the image shows and what it is for in its context, not how it was made: one or two plain sentences, usually under 150 characters, without "image of" or "picture of". If the image has text in it, include that text. It writes one small file and costs nothing.`;

export const imageRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .describe("The image's absolute path, as generate_image or list_images returned it, or just its filename");

const outputSchema = {
  path: z.string().describe("Absolute path of the PNG"),
  sidecar_path: z.string(),
  alt_text: z.string(),
  previous_alt_text: z.string().nullable().describe("The alt text this replaced, or null if there was none"),
};

type Output = { [K in keyof typeof outputSchema]: z.infer<(typeof outputSchema)[K]> };

export function registerSaveAltText(server: McpServer, deps: { storage: Storage }): void {
  server.registerTool(
    "save_alt_text",
    {
      title: "Save alt text",
      description: DESCRIPTION,
      inputSchema: {
        image: imageRefSchema,
        alt_text: z
          .string()
          .trim()
          .min(1)
          .max(MAX_ALT_TEXT_LENGTH)
          .describe("What the image shows, for someone who can't see it"),
      },
      outputSchema,
      // Replacing earlier alt text isn't additive, so it's marked destructive (the old text is returned).
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const image = await deps.storage.find(args.image);
        const before = await deps.storage.updateSidecar(image.sidecarPath, (sidecar) => ({
          ...sidecar,
          alt_text: args.alt_text,
          alt_text_updated_at: new Date().toISOString(),
        }));
        const output: Output = {
          path: image.pngPath,
          sidecar_path: image.sidecarPath,
          alt_text: args.alt_text,
          previous_alt_text: typeof before.alt_text === "string" ? before.alt_text : null,
        };
        const replaced = output.previous_alt_text === null ? "" : ` It replaced: "${output.previous_alt_text}"`;
        return {
          content: [{ type: "text", text: `Saved alt text for ${output.path}.${replaced}\n\n${JSON.stringify(output)}` }],
          structuredContent: output,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!(err instanceof StorageError)) log("warn", "save_alt_text failed", { error: reason });
        return { isError: true, content: [{ type: "text", text: `Couldn't save alt text: ${reason}` }] };
      }
    },
  );
}
