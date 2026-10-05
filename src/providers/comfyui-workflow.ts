import { readFile } from "node:fs/promises";
import { z } from "zod";

// A ComfyUI template is an API-format graph (workflows/<name>.json) plus a mapping
// file (workflows/<name>.map.json) that says where the prompt, seed, and size go,
// which node holds the output, and which model files and custom nodes it needs.
// Code never hard-codes node IDs; only the mapping file knows them. A mapping can name
// an image-to-image companion template (`img2img`), used when there's a reference image;
// its mapping says where the uploaded reference's filename goes.

// Resolved relative to this module so it works from src/, dist/, and an npx install.
const WORKFLOWS_DIR = new URL("../../workflows/", import.meta.url);

const nodeInput = z.object({ node: z.string().min(1), input: z.string().min(1) });

const templateName = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "must be a template name like 'zimage'");

const MappingSchema = z.object({
  model: z.string().min(1),
  seedVariety: z.enum(["low", "high"]),
  sizeMultiple: z.number().int().positive(),
  img2img: templateName.optional(),
  inputs: z.object({
    prompt: nodeInput,
    negativePrompt: nodeInput.optional(),
    seed: nodeInput,
    width: nodeInput,
    height: nodeInput,
    referenceImage: nodeInput.optional(),
    denoise: nodeInput.optional(), // in an image-to-image template: where reference_strength goes
  }),
  output: z.object({ node: z.string().min(1) }),
  models: z.array(
    nodeInput.extend({
      file: z.string().min(1),
      folder: z.string().min(1),
      source: z.string().min(1),
    }),
  ),
  customNodes: z.array(
    z.object({ name: z.string().min(1), source: z.string().min(1), nodes: z.array(z.string().min(1)) }),
  ),
});
export type WorkflowMapping = z.infer<typeof MappingSchema>;

const GraphSchema = z.record(
  z.string(),
  z.looseObject({ class_type: z.string().min(1), inputs: z.record(z.string(), z.unknown()) }),
);
export type WorkflowGraph = z.infer<typeof GraphSchema>;

export interface Workflow {
  name: string;
  graph: WorkflowGraph;
  mapping: WorkflowMapping;
  img2img?: Workflow; // the companion the mapping names, loaded with it
}

export interface WorkflowValues {
  prompt: string;
  negativePrompt?: string | undefined;
  seed: number;
  width: number;
  height: number;
  referenceImage?: string | undefined; // the uploaded file's name in ComfyUI's input folder
  denoise?: number | undefined; // unset keeps the template's own value
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

export async function loadWorkflow(name: string, dir: URL = WORKFLOWS_DIR): Promise<Workflow> {
  const read = async (file: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(new URL(file, dir), "utf8"));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new WorkflowError(`Can't load ComfyUI workflow "${name}" (${file}): ${reason}`);
    }
  };
  const workflow = parseWorkflow(name, await read(`${name}.json`), await read(`${name}.map.json`));
  // A companion as the main template would send its placeholder reference with every text-only request.
  if (workflow.mapping.inputs.referenceImage) {
    throw new WorkflowError(
      `ComfyUI workflow "${name}" is an image-to-image template (its mapping has a referenceImage input). ` +
        "Set COMFYUI_WORKFLOW to the text-to-image template that names it as img2img.",
    );
  }
  const companion = workflow.mapping.img2img;
  if (companion === undefined) return workflow;
  const img2img = parseWorkflow(companion, await read(`${companion}.json`), await read(`${companion}.map.json`));
  if (!img2img.mapping.inputs.referenceImage) {
    throw new WorkflowError(
      `ComfyUI workflow "${name}" names "${companion}" as its image-to-image template, ` +
        "but that mapping has no referenceImage input.",
    );
  }
  if (img2img.mapping.img2img !== undefined) {
    throw new WorkflowError(
      `ComfyUI workflow "${companion}" is an image-to-image template, so it can't name one of its own.`,
    );
  }
  // The provider reports one model and one supports.negativePrompt for both templates, so they must agree.
  if (img2img.mapping.model !== workflow.mapping.model) {
    throw new WorkflowError(
      `ComfyUI workflow "${companion}" uses model "${img2img.mapping.model}", ` +
        `but "${name}" uses "${workflow.mapping.model}"; an image-to-image companion must use the same model.`,
    );
  }
  if ((img2img.mapping.inputs.negativePrompt === undefined) !== (workflow.mapping.inputs.negativePrompt === undefined)) {
    throw new WorkflowError(`ComfyUI workflows "${companion}" and "${name}" must both map a negative prompt, or neither.`);
  }
  return { ...workflow, img2img };
}

/** Validates a template and its mapping against each other. */
export function parseWorkflow(name: string, rawGraph: unknown, rawMapping: unknown): Workflow {
  const problem = (what: string, error: z.ZodError) =>
    new WorkflowError(`ComfyUI workflow "${name}" has an invalid ${what}: ${z.prettifyError(error)}`);
  const graph = GraphSchema.safeParse(rawGraph);
  if (!graph.success) throw problem("template", graph.error);
  const mapping = MappingSchema.safeParse(rawMapping);
  if (!mapping.success) throw problem("mapping file", mapping.error);

  const g = graph.data;
  const m = mapping.data;
  const refs = [...Object.values(m.inputs).filter((r) => r !== undefined), ...m.models];
  for (const ref of refs) {
    if (!(ref.input in (g[ref.node]?.inputs ?? {}))) {
      throw new WorkflowError(
        `ComfyUI workflow "${name}": the mapping points at input "${ref.input}" of node "${ref.node}", which the template doesn't have.`,
      );
    }
  }
  if (!g[m.output.node]) {
    throw new WorkflowError(`ComfyUI workflow "${name}": output node "${m.output.node}" is not in the template.`);
  }
  return { name, graph: g, mapping: m };
}

/** Returns a copy of the template with the request's values and the mapped model files filled in. */
export function buildGraph(workflow: Workflow, values: WorkflowValues): WorkflowGraph {
  const graph = structuredClone(workflow.graph);
  const set = (ref: { node: string; input: string }, value: unknown) => {
    const node = graph[ref.node];
    if (node) node.inputs[ref.input] = value;
  };
  const { inputs, models } = workflow.mapping;
  set(inputs.prompt, values.prompt);
  if (inputs.negativePrompt) set(inputs.negativePrompt, values.negativePrompt ?? "");
  set(inputs.seed, values.seed);
  set(inputs.width, values.width);
  set(inputs.height, values.height);
  if (inputs.referenceImage && values.referenceImage !== undefined) set(inputs.referenceImage, values.referenceImage);
  if (inputs.denoise && values.denoise !== undefined) set(inputs.denoise, values.denoise);
  for (const model of models) set(model, model.file);
  return graph;
}

/** The template and its image-to-image companion, if it has one. */
export function templates(workflow: Workflow): Workflow[] {
  return workflow.img2img ? [workflow, workflow.img2img] : [workflow];
}

/** Every node class the template (and its companion) uses, for the health check. */
export function nodeClasses(workflow: Workflow): string[] {
  return [...new Set(templates(workflow).flatMap((t) => Object.values(t.graph).map((n) => n.class_type)))];
}
