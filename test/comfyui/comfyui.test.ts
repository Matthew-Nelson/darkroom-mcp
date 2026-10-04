import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createComfyUIProvider } from "../../src/providers/comfyui.js";
import { loadWorkflow } from "../../src/providers/comfyui-workflow.js";
import type { ProgressUpdate } from "../../src/providers/types.js";

// Runs against a real local ComfyUI (`npm run test:comfyui`), at draft quality.
// Takes a few minutes on a 16GB M3. Not part of `npm test`.

const url = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";
const provider = createComfyUIProvider({ url, timeoutMs: 300_000, workflow: await loadWorkflow("zimage") });

describe("comfyui provider against a real ComfyUI", () => {
  it("is healthy", async () => {
    expect(await provider.healthCheck()).toEqual({ ok: true });
  });

  it("renders a 1:1 draft with step progress", async () => {
    const updates: ProgressUpdate[] = [];
    const started = Date.now();
    const result = await provider.generate(
      { prompt: 'A ceramic coffee mug on a wooden desk, the mug reads "DARKROOM"', aspectRatio: "1:1", quality: "draft", seed: 42 },
      new AbortController().signal,
      (u) => updates.push(u),
    );
    const meta = await sharp(result.png).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 512, 512]);
    expect(result).toMatchObject({ width: 512, height: 512, seed: 42, model: "z-image-turbo-q4_k_m" });
    expect(updates.filter((u) => u.step !== undefined).at(-1)).toMatchObject({ step: 8, totalSteps: 8 });
    process.stderr.write(`draft took ${Math.round((Date.now() - started) / 1000)}s\n`);
  });

  it("stops the GPU job when the caller aborts mid-sampling", async () => {
    const ac = new AbortController();
    const run = provider.generate({ prompt: "a red bicycle", aspectRatio: "1:1", quality: "draft" }, ac.signal, (u) => {
      if (u.step === 1) ac.abort();
    });
    await expect(run).rejects.toThrow("Generation was cancelled. ComfyUI is stopping the job.");
    // Interrupts land between sampler steps, so allow one step (~15s) to finish.
    const deadline = Date.now() + 30_000;
    let queue: { queue_running: unknown[]; queue_pending: unknown[] };
    do {
      queue = (await (await fetch(`${url}/queue`)).json()) as typeof queue;
      if (queue.queue_running.length === 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    } while (Date.now() < deadline);
    expect(queue).toEqual({ queue_running: [], queue_pending: [] });
  });
});
