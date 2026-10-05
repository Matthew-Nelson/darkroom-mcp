import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGraph, loadWorkflow, nodeClasses, parseWorkflow, WorkflowError } from "../../src/providers/comfyui-workflow.js";

describe("ComfyUI workflow templates", () => {
  it("loads the bundled zimage template and mapping", async () => {
    const wf = await loadWorkflow("zimage");
    expect(wf.mapping.model).toBe("z-image-turbo-q4_k_m");
    expect(wf.mapping.seedVariety).toBe("low");
    expect(nodeClasses(wf)).toEqual(
      expect.arrayContaining(["UnetLoaderGGUF", "CLIPLoaderGGUF", "VAELoader", "KSampler", "PreviewImage"]),
    );
  });

  it("keeps the template's model filenames in sync with the mapping, so the template also loads in ComfyUI as-is", async () => {
    const wf = await loadWorkflow("zimage");
    for (const t of [wf, wf.img2img]) {
      for (const m of t?.mapping.models ?? []) expect(t?.graph[m.node]?.inputs[m.input]).toBe(m.file);
    }
  });

  it("loads zimage's image-to-image companion, which encodes the reference instead of an empty latent", async () => {
    const wf = await loadWorkflow("zimage");
    const i2i = wf.img2img;
    expect(i2i?.name).toBe("zimage-img2img");
    expect(i2i?.mapping.inputs.referenceImage).toEqual({ node: "reference", input: "image" });
    expect(i2i?.mapping.inputs.denoise).toEqual({ node: "sample", input: "denoise" });
    expect(i2i?.graph.sample?.inputs.latent_image).toEqual(["encode", 0]);
    expect(i2i?.graph.sample?.inputs.denoise).toBeLessThan(1);
    expect(nodeClasses(wf)).toEqual(expect.arrayContaining(["LoadImage", "ImageScale", "VAEEncode", "EmptySD3LatentImage"]));
    // Everything but the start of the pipeline matches the text-to-image template.
    for (const id of ["unet", "shift", "clip", "vae", "pos", "neg", "decode", "output"]) {
      expect(i2i?.graph[id]).toEqual(wf.graph[id]);
    }
  });

  it("fills in the uploaded reference's name", async () => {
    const i2i = (await loadWorkflow("zimage")).img2img;
    if (!i2i) throw new Error("expected a companion");
    const graph = buildGraph(i2i, { prompt: "p", seed: 1, width: 624, height: 416, referenceImage: "darkroom/x.png" });
    expect(graph.reference?.inputs.image).toBe("darkroom/x.png");
    expect(graph.sample?.inputs.denoise).toBe(0.5); // the template's default when no strength is given
    const stronger = buildGraph(i2i, { prompt: "p", seed: 1, width: 64, height: 64, denoise: 0.75 });
    expect(stronger.sample?.inputs.denoise).toBe(0.75);
    expect([graph.scale?.inputs.width, graph.scale?.inputs.height]).toEqual([624, 416]);
  });

  it("fills in prompt, seed, and size without touching the template", async () => {
    const wf = await loadWorkflow("zimage");
    const graph = buildGraph(wf, { prompt: "a red bicycle", seed: 7, width: 688, height: 384 });
    expect(graph.pos?.inputs.text).toBe("a red bicycle");
    expect(graph.sample?.inputs.seed).toBe(7);
    expect([graph.latent?.inputs.width, graph.latent?.inputs.height]).toEqual([688, 384]);
    expect(graph.unet?.inputs.unet_name).toBe("z_image_turbo-Q4_K_M.gguf");
    expect(wf.graph.pos?.inputs.text).toBe("");
  });

  it("fails clearly for an unknown template name", async () => {
    await expect(loadWorkflow("nope")).rejects.toThrow(/Can't load ComfyUI workflow "nope" \(nope\.json\)/);
  });

  const graph = {
    a: { class_type: "CLIPTextEncode", inputs: { text: "" } },
    b: { class_type: "SaveImage", inputs: {} },
  };
  const mapping = {
    model: "m",
    seedVariety: "high",
    sizeMultiple: 8,
    inputs: {
      prompt: { node: "a", input: "text" },
      seed: { node: "a", input: "text" },
      width: { node: "a", input: "text" },
      height: { node: "a", input: "text" },
    },
    output: { node: "b" },
    models: [],
    customNodes: [],
  };

  it("accepts a consistent template and mapping", () => {
    expect(parseWorkflow("t", graph, mapping).mapping.sizeMultiple).toBe(8);
  });

  it("rejects a mapping that points at a missing node input", () => {
    const bad = { ...mapping, inputs: { ...mapping.inputs, seed: { node: "sampler", input: "seed" } } };
    expect(() => parseWorkflow("t", graph, bad)).toThrow(/input "seed" of node "sampler"/);
  });

  it("rejects a missing output node", () => {
    expect(() => parseWorkflow("t", graph, { ...mapping, output: { node: "save" } })).toThrow(/output node "save"/);
  });

  it("rejects a malformed mapping file", () => {
    expect(() => parseWorkflow("t", graph, { ...mapping, seedVariety: "medium" })).toThrow(WorkflowError);
    expect(() => parseWorkflow("t", { a: { inputs: {} } }, mapping)).toThrow(/invalid template/);
  });

  describe("an image-to-image companion", () => {
    async function load(main: unknown, companion: unknown): Promise<unknown> {
      const dir = await mkdtemp(join(tmpdir(), "darkroom-wf-"));
      try {
        await writeFile(join(dir, "t.json"), JSON.stringify(graph));
        await writeFile(join(dir, "t.map.json"), JSON.stringify(main));
        await writeFile(join(dir, "t2.json"), JSON.stringify(graph));
        await writeFile(join(dir, "t2.map.json"), JSON.stringify(companion));
        return await loadWorkflow("t", pathToFileURL(`${dir}/`));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const withRef = { ...mapping, inputs: { ...mapping.inputs, referenceImage: { node: "a", input: "text" } } };

    it("is loaded with the template that names it", async () => {
      const wf = (await load({ ...mapping, img2img: "t2" }, withRef)) as { img2img?: { name: string } };
      expect(wf.img2img?.name).toBe("t2");
    });

    it("must say where the reference goes", async () => {
      await expect(load({ ...mapping, img2img: "t2" }, mapping)).rejects.toThrow(/"t2".*has no referenceImage input/);
    });

    it("can't name a companion of its own", async () => {
      await expect(load({ ...mapping, img2img: "t2" }, { ...withRef, img2img: "t" })).rejects.toThrow(/can't name one of its own/);
    });

    it("fails clearly when its files are missing", async () => {
      await expect(load({ ...mapping, img2img: "nope" }, withRef)).rejects.toThrow(/Can't load ComfyUI workflow "t" \(nope\.json\)/);
    });
  });
});
