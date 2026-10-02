import { PAID_PROVIDERS, type Config, type ProviderName } from "./config.js";
import type { Ledger, Reservation } from "./ledger.js";
import { log } from "./log.js";
import {
  ProviderError,
  type GenerateRequest,
  type GenerateResult,
  type ImageProvider,
  type ProgressListener,
} from "./providers/types.js";

// M2 router: picks the explicit provider, or the first available and healthy one
// in the configured order, and runs every paid call through the spend ledger.
// Fallback on failure and health caching arrive in M3 (see SPEC.md).

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
    private readonly ledger: Ledger,
  ) {}

  async generate(
    req: GenerateRequest,
    opts: { provider?: ProviderName | undefined; signal: AbortSignal; onProgress?: ProgressListener },
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
    // The first provider passed over that wasn't known to be paid. Once one is,
    // the hard rule applies: no paid provider without DARKROOM_ALLOW_PAID_FALLBACK.
    let freeSkipped: ProviderName | undefined;

    for (const name of candidates) {
      const provider = this.providers.get(name);
      if (!provider) {
        skipped.push({ provider: name, reason: "not available in this version of Darkroom yet" });
        if (!PAID_PROVIDERS.has(name)) freeSkipped ??= name;
        continue;
      }
      if (provider.isPaid && freeSkipped && !this.config.allowPaidFallback) {
        skipped.push({
          provider: name,
          reason:
            `not used because ${freeSkipped} was skipped and this provider costs money; ` +
            "DARKROOM_ALLOW_PAID_FALLBACK=true allows this",
        });
        continue;
      }
      const health = await provider.healthCheck().catch((err: unknown) => ({
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      }));
      if (!health.ok) {
        skipped.push({ provider: name, reason: `unhealthy: ${health.detail ?? "health check failed"}` });
        if (!provider.isPaid) freeSkipped ??= name;
        continue;
      }

      // A cancel during the health checks above must not reserve spend for a call never made.
      opts.signal.throwIfAborted();
      let reservation: Reservation | undefined;
      if (provider.isPaid) {
        try {
          reservation = await this.ledger.reserve({
            provider: name,
            estimateUsd: provider.estimateCostUsd(req),
            capUsd: this.config.dailyCapUsd,
          });
        } catch (err) {
          skipped.push({ provider: name, reason: err instanceof Error ? err.message : String(err) });
          continue;
        }
      }

      let result: GenerateResult;
      try {
        result = await provider.generate(req, opts.signal, opts.onProgress);
      } catch (err) {
        if (reservation) await this.closeFailed(reservation, err);
        throw err;
      }
      if (reservation) {
        if (result.actualCostUsd !== undefined && result.actualCostUsd > reservation.estimateUsd) {
          // The cap was checked against the estimate, so a low one lets in-flight calls overshoot it.
          log("warn", "actual cost exceeded the estimate", {
            provider: name,
            estimate_usd: reservation.estimateUsd,
            actual_usd: result.actualCostUsd,
          });
        }
        await this.ledger.settle(reservation, result.actualCostUsd).catch((err: unknown) => {
          // The image was paid for either way. The ledger couldn't be written, so its
          // reservation (if on disk) keeps counting the estimate instead of the actual cost.
          log("error", "could not settle spend reservation", { error: errorMessage(err) });
        });
      }
      return { provider, result, skipped };
    }

    const reasons = skipped.map((s) => `${s.provider}: ${s.reason}`).join("; ");
    throw new NoProviderError(`No image provider could take this request (${reasons}).`, skipped);
  }

  private async closeFailed(reservation: Reservation, err: unknown): Promise<void> {
    const note = errorMessage(err);
    const close =
      err instanceof ProviderError && err.notCharged
        ? this.ledger.release(reservation, note)
        : this.ledger.keep(reservation, note);
    await close.catch((ledgerErr: unknown) => {
      log("error", "could not record failed paid call", { error: errorMessage(ledgerErr) });
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
