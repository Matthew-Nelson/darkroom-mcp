import type { Config, ProviderName } from "../config.js";
import { createComfyUIProvider } from "./comfyui.js";
import { loadWorkflow } from "./comfyui-workflow.js";
import { createMockProvider } from "./mock.js";
import { createOpenAIProvider } from "./openai.js";
import type { ImageProvider } from "./types.js";

type ProviderFactory = (config: Config) => ImageProvider | Promise<ImageProvider>;

// Adding a provider: one new file in this folder plus one line here.
const FACTORIES: Partial<Record<ProviderName, ProviderFactory>> = {
  mock: () => createMockProvider(),
  comfyui: async ({ comfyui }) =>
    createComfyUIProvider({ url: comfyui.url, timeoutMs: comfyui.timeoutMs, workflow: await loadWorkflow(comfyui.workflow) }),
  openai: ({ openai }) => createOpenAIProvider(openai),
};

/**
 * Builds the implemented providers that appear in the configured order. Throws
 * (failing startup) if one can't be built, e.g. COMFYUI_WORKFLOW names a missing template.
 */
export async function createProviders(config: Config): Promise<Map<ProviderName, ImageProvider>> {
  const providers = new Map<ProviderName, ImageProvider>();
  for (const name of config.providerOrder) {
    const factory = FACTORIES[name];
    if (factory) providers.set(name, await factory(config));
  }
  return providers;
}
