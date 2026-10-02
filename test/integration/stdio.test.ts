import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SERVER = new URL("../../dist/index.js", import.meta.url).pathname;

let outputDir: string;
let client: Client | undefined;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "darkroom-it-"));
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await rm(outputDir, { recursive: true, force: true });
});

async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...getDefaultEnvironment(), DARKROOM_OUTPUT_DIR: outputDir, ...env },
    stderr: "pipe",
  });
  client = new Client({ name: "darkroom-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function call(c: Client, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await c.callTool({ name: "generate_image", arguments: args })) as CallToolResult;
}

describe("darkroom over stdio", () => {
  it("lists generate_image with input and output schemas", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["generate_image"]);
    const tool = tools[0];
    expect(tool?.description).toMatch(/only pass "provider" when the user explicitly asks/i);
    expect(tool?.inputSchema.required).toEqual(["prompt"]);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
      "prompt",
      "negative_prompt",
      "aspect_ratio",
      "quality",
      "provider",
      "seed",
      "filename",
    ]);
    expect(tool?.outputSchema?.properties).toHaveProperty("path");
  });

  it("generates a mock image: preview, summary, structured content, PNG and sidecar on disk", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    const result = await call(c, {
      prompt: "a ceramic mug that says DARKROOM",
      negative_prompt: "blurry",
      aspect_ratio: "16:9",
      quality: "final",
      seed: 42,
      filename: "../Mug Test.png",
    });

    expect(result.isError).toBeFalsy();
    const [image, text] = result.content;
    expect(image?.type).toBe("image");
    expect(text?.type).toBe("text");

    // Preview: JPEG, at most 768px on the long edge.
    if (image?.type !== "image") throw new Error("expected an image block");
    expect(image.mimeType).toBe("image/jpeg");
    const preview = await sharp(Buffer.from(image.data, "base64")).metadata();
    expect([preview.format, preview.width, preview.height]).toEqual(["jpeg", 768, 434]);

    const out = result.structuredContent as Record<string, unknown>;
    expect(out).toMatchObject({
      provider: "mock",
      model: "mock-placeholder-v1",
      width: 1360,
      height: 768,
      seed: 42,
      cost_usd: 0,
      cost_is_estimate: false,
      ignored_params: ["negative_prompt"],
      skipped_providers: [],
    });
    expect(out.latency_ms).toEqual(expect.any(Number));

    const pngPath = out.path as string;
    expect(pngPath).toMatch(/\/mug-test-[0-9a-f]{8}\.png$/);
    expect(dirname(pngPath)).toBe(dirname(out.sidecar_path as string));
    const png = await sharp(pngPath).metadata();
    expect([png.format, png.width, png.height]).toEqual(["png", 1360, 768]);

    const sidecar = JSON.parse(await readFile(out.sidecar_path as string, "utf8")) as Record<string, unknown>;
    expect(sidecar).toMatchObject({
      version: 1,
      image: pngPath.split("/").pop(),
      provider: "mock",
      seed: 42,
      request: { prompt: "a ceramic mug that says DARKROOM", aspect_ratio: "16:9", quality: "final" },
    });
    expect(Date.parse(sidecar.created_at as string)).not.toBeNaN();

    if (text?.type !== "text") throw new Error("expected a text block");
    expect(text.text).toContain(`Saved ${pngPath}`);
    expect(text.text).toContain("Ignored by this provider: negative_prompt.");
  });

  it("applies defaults: 1:1 draft", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    const out = (await call(c, { prompt: "hello" })).structuredContent as Record<string, unknown>;
    expect([out.width, out.height]).toEqual([512, 512]);
  });

  it("rejects invalid input through the schema", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    for (const args of [{ prompt: "" }, { prompt: "x".repeat(4001) }, { prompt: "x", aspect_ratio: "4:3" }]) {
      const result = await call(c, args);
      expect(result.isError).toBe(true);
    }
  });

  it("sends progress notifications when the client asks for them", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    const updates: { progress: number; message?: string | undefined }[] = [];
    const result = (await c.callTool({ name: "generate_image", arguments: { prompt: "hello" } }, undefined, {
      onprogress: (p) => updates.push(p),
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(updates[0]?.message).toMatch(/^Drawing placeholder \(\d+s\)$/);
    expect(updates[0]?.progress).toBeGreaterThan(0);
  });

  it("with the default order and ComfyUI not running, says how to fix it", async () => {
    const port = await closedPort();
    const c = await connect({ COMFYUI_URL: `http://127.0.0.1:${port}` });
    const result = await call(c, { prompt: "hello" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: `No image provider could take this request (comfyui: unhealthy: Can't reach ComfyUI at http://127.0.0.1:${port} (ECONNREFUSED). Is it running? Set COMFYUI_URL if it isn't at that address.).`,
    });
  });

  it("fails at startup when COMFYUI_WORKFLOW names a missing template", () => {
    const run = spawnSync(process.execPath, [SERVER], {
      env: { ...getDefaultEnvironment(), DARKROOM_OUTPUT_DIR: outputDir, COMFYUI_WORKFLOW: "nope" },
      input: "",
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`[darkroom] error: Can't load ComfyUI workflow "nope" (nope.json): ENOENT`);
  });

  it("exits with a readable message when config is invalid", () => {
    const run = spawnSync(process.execPath, [SERVER], {
      env: { ...getDefaultEnvironment(), DARKROOM_OUTPUT_DIR: "relative/dir", DARKROOM_PROVIDER_ORDER: "dalle" },
      input: "",
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Invalid Darkroom configuration");
    expect(run.stderr).toContain("DARKROOM_OUTPUT_DIR: must be an absolute path");
    expect(run.stderr).toContain("DARKROOM_PROVIDER_ORDER: each provider must be one of");
  });
});
