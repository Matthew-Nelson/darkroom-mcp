import type { Config, ProviderName } from "./config.js";
import type { GenerateRequest, GenerateResult, ImageProvider } from "./providers/types.js";

// M0 router: picks the explicit provider, or the first available and healthy one
// in the configured order. Fallback on failure, health caching, and the spend
// ledger arrive in later milestones (see SPEC.md).

export interface SkippedProvider {
  provider: ProviderName;
  reason: string;
}

export interface RoutedResult {
  provider: ImageProvider;
  result: GenerateResult;
  skipped: SkippedProvider[];
}

export class NoProviderError extends Error {
  constructor(
    message: string,
    public readonly skipped: SkippedProvider[],
  ) {
    super(message);
    this.name = "NoProviderError";
  }
}

export class Router {
  constructor(
    private readonly config: Config,
    private readonly providers: ReadonlyMap<ProviderName, ImageProvider>,
  ) {}

  async generate(
    req: GenerateRequest,
    opts: { provider?: ProviderName | undefined; signal: AbortSignal },
  ): Promise<RoutedResult> {
    if (opts.provider && !this.config.providerOrder.includes(opts.provider)) {
      throw new NoProviderError(
        `Provider "${opts.provider}" is not enabled. Enabled providers: ${this.config.providerOrder.join(", ")}. ` +
          "To enable it, add it to DARKROOM_PROVIDER_ORDER.",
        [],
      );
    }
    const candidates = opts.provider ? [opts.provider] : this.config.providerOrder;
    const skipped: SkippedProvider[] = [];

    for (const name of candidates) {
      const provider = this.providers.get(name);
      if (!provider) {
        skipped.push({ provider: name, reason: "not available in this version of Darkroom yet" });
        continue;
      }
      // Hard rule from the spec: no paid call without the ledger and cap, which land in M2.
      if (provider.isPaid) {
        skipped.push({ provider: name, reason: "paid providers are not supported in this version yet" });
        continue;
      }
      const health = await provider.healthCheck().catch((err: unknown) => ({
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      }));
      if (!health.ok) {
        skipped.push({ provider: name, reason: `unhealthy: ${health.detail ?? "health check failed"}` });
        continue;
      }
      const result = await provider.generate(req, opts.signal);
      return { provider, result, skipped };
    }

    const reasons = skipped.map((s) => `${s.provider}: ${s.reason}`).join("; ");
    throw new NoProviderError(`No image provider could take this request (${reasons}).`, skipped);
  }
}
