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
    for (const m of wf.mapping.models) expect(wf.graph[m.node]?.inputs[m.input]).toBe(m.file);
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
});
