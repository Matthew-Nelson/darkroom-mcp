import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SERVER = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

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
  it("lists all the tools, and generate_image's input and output schemas", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "generate_image",
      "list_providers",
      "list_images",
      "save_alt_text",
      "check_contrast",
    ]);
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
      "reference_image",
      "reference_strength",
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
      reference_image: null,
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

  it("keeps a generated image in the temp folder when the output directory can't be written", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    await rm(outputDir, { recursive: true });
    await writeFile(outputDir, "a file where the output directory should be");

    const result = await call(c, { prompt: "rescue me" });
    expect(result.isError).toBe(true);
    const [block] = result.content;
    const text = block?.type === "text" ? block.text : "";
    const rescued = /The image was kept at (\S+\.png) instead\./.exec(text)?.[1];
    expect(text).toMatch(/^Generated an image with mock \(\$0\.00\), but couldn't save it to /);
    expect(rescued).toBeDefined();
    try {
      expect((await sharp(rescued).metadata()).format).toBe("png");
    } finally {
      if (rescued) await rm(rescued, { force: true });
    }
  });

  it("applies defaults: 1:1 draft", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    const out = (await call(c, { prompt: "hello" })).structuredContent as Record<string, unknown>;
    expect([out.width, out.height]).toEqual([512, 512]);
  });

  it("bases an image on a reference: matches its shape, records it, and accepts an earlier image by filename", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    const photo = join(outputDir, "..", `${basename(outputDir)}-photo.jpg`);
    await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#cc3333" } }).jpeg().toFile(photo);
    const real = await realpath(photo); // what the result reports (the temp folder is behind a symlink on macOS)
    try {
      const result = await call(c, { prompt: "the same scene at night", reference_image: photo });
      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as Record<string, unknown>;
      expect(out).toMatchObject({ provider: "mock", width: 688, height: 384, reference_image: real });
      const [, text] = result.content;
      expect(text?.type === "text" && text.text).toContain(`Based on the reference image ${real}.`);

      const sidecar = JSON.parse(await readFile(out.sidecar_path as string, "utf8")) as Record<string, unknown>;
      expect(sidecar).toMatchObject({
        request: { reference_image: photo, aspect_ratio: "16:9" },
        reference_image: real,
        reference: { format: "jpeg", width: 1600, height: 900 },
      });
      expect((sidecar.reference as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);

      // An explicit aspect ratio wins, and an earlier Darkroom image can be named by its filename.
      // The mock has no strength dial, so it reports reference_strength as ignored.
      const byName = basename(out.path as string);
      const again = await call(c, { prompt: "sq", reference_image: byName, aspect_ratio: "1:1", reference_strength: 0.7 });
      expect(again.structuredContent).toMatchObject({
        width: 512,
        height: 512,
        reference_image: out.path,
        ignored_params: ["reference_strength"],
      });
    } finally {
      await rm(photo, { force: true });
    }
  });

  it("refuses a reference that isn't an image before calling any provider", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    const result = await call(c, { prompt: "x", reference_image: join(outputDir, "missing.png") });
    expect(result.isError).toBe(true);
    const [block] = result.content;
    expect(block?.type === "text" && block.text).toMatch(/^Couldn't use the reference image: No file at /);
  });

  it("rejects invalid input through the schema", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    const bad = [
      { prompt: "" },
      { prompt: "x".repeat(4001) },
      { prompt: "x", aspect_ratio: "4:3" },
      { prompt: "x", reference_strength: 0 },
      { prompt: "x", reference_strength: 1.5 },
    ];
    for (const args of bad) {
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

  // None of the paid tests below reach the network: each is refused before the API call.
  const FAKE_KEY = "sk-proj-FAKEKEYFORSTDIOTESTS0123456789";

  it("ignores a generic OPENAI_API_KEY: openai stays unhealthy", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "openai", OPENAI_API_KEY: FAKE_KEY });
    const result = await call(c, { prompt: "hello" });
    expect(result.isError).toBe(true);
    const [block] = result.content;
    expect(block?.type === "text" && block.text).toMatch(
      /^No image provider could take this request \(openai: unhealthy: DARKROOM_OPENAI_API_KEY is not set\./,
    );
  });

  it("refuses a paid request over the daily cap, while the same request runs on mock", async () => {
    const c = await connect({
      DARKROOM_PROVIDER_ORDER: "mock,openai",
      DARKROOM_OPENAI_API_KEY: FAKE_KEY,
      DARKROOM_DAILY_CAP_USD: "0.001", // below any OpenAI estimate, so the request never leaves
    });
    const args = { prompt: "a mug that says DARKROOM", aspect_ratio: "3:2" };
    expect((await call(c, { ...args, provider: "mock" })).isError).toBeFalsy();

    const result = await call(c, { ...args, provider: "openai" });
    expect(result.isError).toBe(true);
    const [block] = result.content;
    const text = block?.type === "text" ? block.text : "";
    expect(text).toMatch(/^No image provider could take this request \(openai: daily spend cap reached: \$0\.00 of \$0\.001 already/);
    expect(text).not.toContain(FAKE_KEY);
  });

  it("doesn't fall from a stopped ComfyUI to a paid provider without the flag", async () => {
    const port = await closedPort();
    const c = await connect({
      COMFYUI_URL: `http://127.0.0.1:${port}`,
      DARKROOM_PROVIDER_ORDER: "comfyui,openai",
      DARKROOM_OPENAI_API_KEY: FAKE_KEY,
    });
    const result = await call(c, { prompt: "hello" });
    expect(result.isError).toBe(true);
    const [block] = result.content;
    expect(block?.type === "text" && block.text).toContain(
      "openai: not used because comfyui was skipped and this provider costs money; DARKROOM_ALLOW_PAID_FALLBACK=true allows this",
    );
  });

  it("list_providers reports health, cost, the paid gate, and spend, without the key", async () => {
    const port = await closedPort();
    const c = await connect({
      COMFYUI_URL: `http://127.0.0.1:${port}`,
      DARKROOM_PROVIDER_ORDER: "comfyui,openai",
      DARKROOM_OPENAI_API_KEY: FAKE_KEY,
    });
    const tool = (await c.listTools()).tools.find((t) => t.name === "list_providers");
    expect(tool?.annotations?.readOnlyHint).toBe(true);

    const result = (await c.callTool({ name: "list_providers", arguments: {} })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      providers: { name: string; healthy: boolean | null; detail: string | null; estimated_cost_usd: { draft: number } | null }[];
      spend: { spent_usd: number; cap_usd: number };
    };
    expect(out.providers.map((p) => p.name)).toEqual(["comfyui", "openai", "mock", "gemini"]);
    const [comfyui, openai] = out.providers;
    expect(comfyui?.healthy).toBe(false);
    expect(comfyui?.detail).toMatch(/Can't reach ComfyUI/);
    expect(openai?.healthy).toBe(true);
    expect(openai?.detail).toMatch(/^Used only when asked for by name/);
    expect(openai?.estimated_cost_usd?.draft).toBeGreaterThan(0);
    expect(out.spend).toMatchObject({ spent_usd: 0, cap_usd: 2 });
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it("list_images returns what generate_image saved, newest first, and filters by provider", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    const first = await call(c, { prompt: "first mug" });
    const second = await call(c, { prompt: "second mug", aspect_ratio: "16:9" });
    const tool = (await c.listTools()).tools.find((t) => t.name === "list_images");
    expect(tool?.annotations?.readOnlyHint).toBe(true);

    const result = (await c.callTool({ name: "list_images", arguments: {} })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { images: { path: string; prompt: string; aspect_ratio: string }[]; total: number };
    expect(out.total).toBe(2);
    expect(out.images.map((i) => i.prompt)).toEqual(["second mug", "first mug"]);
    expect(out.images.map((i) => i.path)).toEqual([
      (second.structuredContent as { path: string }).path,
      (first.structuredContent as { path: string }).path,
    ]);
    expect(out.images[0]?.aspect_ratio).toBe("16:9");

    const limited = (await c.callTool({ name: "list_images", arguments: { limit: 1 } })) as CallToolResult;
    expect((limited.structuredContent as { images: unknown[] }).images).toHaveLength(1);
    const filtered = (await c.callTool({ name: "list_images", arguments: { provider: "openai" } })) as CallToolResult;
    expect(filtered.structuredContent).toEqual({ images: [], total: 0, unreadable: 0 });
  });

  it("save_alt_text writes alt text that list_images then returns, and says what it replaced", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    const generated = (await call(c, { prompt: "a mug" })).structuredContent as { path: string; sidecar_path: string };
    const save = async (image: string, altText: string) =>
      (await c.callTool({ name: "save_alt_text", arguments: { image, alt_text: altText } })) as CallToolResult;

    const first = await save(generated.path, "A plain grey placeholder.");
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toEqual({
      path: generated.path,
      sidecar_path: generated.sidecar_path,
      alt_text: "A plain grey placeholder.",
      previous_alt_text: null,
    });

    // By filename this time, replacing the first.
    const second = await save(basename(generated.path), "  A grey placeholder with the prompt in it.  ");
    expect(second.structuredContent).toMatchObject({
      alt_text: "A grey placeholder with the prompt in it.",
      previous_alt_text: "A plain grey placeholder.",
    });

    const sidecar = JSON.parse(await readFile(generated.sidecar_path, "utf8")) as Record<string, unknown>;
    expect(sidecar).toMatchObject({ provider: "mock", alt_text: "A grey placeholder with the prompt in it." });
    expect(Date.parse(sidecar.alt_text_updated_at as string)).not.toBeNaN();

    const listed = (await c.callTool({ name: "list_images", arguments: {} })) as CallToolResult;
    expect((listed.structuredContent as { images: { alt_text: string | null }[] }).images[0]?.alt_text).toBe(
      "A grey placeholder with the prompt in it.",
    );
    const [block] = listed.content;
    expect(block?.type === "text" && block.text).toContain("Alt text: A grey placeholder with the prompt in it.");

    const missing = await save("/etc/passwd", "nope");
    expect(missing.isError).toBe(true);
    const [error] = missing.content;
    expect(error?.type === "text" && error.text).toMatch(/^Couldn't save alt text: .*isn't in Darkroom's output folder/);
  });

  it("check_contrast reports the mock's background and judges white text on it", async () => {
    const c = await connect({ DARKROOM_PROVIDER_ORDER: "mock" });
    const tool = (await c.listTools()).tools.find((t) => t.name === "check_contrast");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    const generated = (await call(c, { prompt: "a mug", seed: 7 })).structuredContent as { path: string };
    const check = async (args: Record<string, unknown>) =>
      (await c.callTool({ name: "check_contrast", arguments: { image: generated.path, ...args } })) as CallToolResult;

    // The bottom-right corner is plain background: the mock's text is top-left, its footer bottom-left.
    const result = await check({ text_colors: ["#ffffff", "#000"], region: { x: 0.75, y: 0.75, width: 0.25, height: 0.25 } });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      region: { left: number; top: number; width: number; height: number };
      dominant_colors: { color: string; share: number }[];
      results: { text_color: string; worst_against: string; worst_ratio: number; body_text_aa: boolean }[];
    };
    expect(out.region).toEqual({ left: 384, top: 384, width: 128, height: 128 });
    expect(out.dominant_colors).toHaveLength(1);
    const background = out.dominant_colors[0]?.color;
    expect(out.results.map((r) => [r.text_color, r.worst_against])).toEqual([
      ["#ffffff", background],
      ["#000000", background],
    ]);
    // White and black against the same background: their ratios multiply to 21 (within rounding).
    const [white, black] = out.results;
    expect((white?.worst_ratio ?? 0) * (black?.worst_ratio ?? 0)).toBeCloseTo(21, 0);
    const [text] = result.content;
    expect(text?.type === "text" && text.text).toMatch(/^Checked the region at 384,384 \(128×128px\) of /);

    const bad = await check({ text_colors: ["white"] });
    expect(bad.isError).toBe(true);
    const [error] = bad.content;
    expect(error?.type === "text" && error.text).toContain("Use a hex color");
  });

  it("fails at startup when DARKROOM_OPENAI_MODEL has no known prices", () => {
    const run = spawnSync(process.execPath, [SERVER], {
      env: {
        ...getDefaultEnvironment(),
        DARKROOM_OUTPUT_DIR: outputDir,
        DARKROOM_PROVIDER_ORDER: "openai",
        DARKROOM_OPENAI_MODEL: "dall-e-3",
      },
      input: "",
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`DARKROOM_OPENAI_MODEL: "dall-e-3" isn't a model Darkroom has prices for`);
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
