import type { Config, ProviderName } from "../config.js";
import { createMockProvider } from "./mock.js";
import type { ImageProvider } from "./types.js";

type ProviderFactory = (config: Config) => ImageProvider;

// Adding a provider: one new file in this folder plus one line here.
const FACTORIES: Partial<Record<ProviderName, ProviderFactory>> = {
  mock: () => createMockProvider(),
};

/** Builds the implemented providers that appear in the configured order. */
export function createProviders(config: Config): Map<ProviderName, ImageProvider> {
  const providers = new Map<ProviderName, ImageProvider>();
  for (const name of config.providerOrder) {
    const factory = FACTORIES[name];
    if (factory) providers.set(name, factory(config));
  }
  return providers;
}
