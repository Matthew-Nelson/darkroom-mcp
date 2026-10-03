import { PAID_PROVIDERS, type Config, type ProviderName } from "./config.js";
import type { Ledger, Reservation } from "./ledger.js";
import { log } from "./log.js";
import {
  ContentRefusedError,
  ProviderError,
  type GenerateRequest,
  type GenerateResult,
  type ImageProvider,
  type ProgressListener,
} from "./providers/types.js";

// Picks the explicit provider, or walks the configured order: skips unavailable and
// unhealthy providers, falls back to the next one when a call fails, and runs every
// paid call through the spend ledger. See "Routing, fallback and spend cap" in SPEC.md.

// How long a healthy result is reused before checking again.
export const HEALTH_CACHE_MS = 60_000;

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
  // Only healthy results are cached: an unhealthy provider is checked again on
  // every call, so one that comes back (e.g. ComfyUI started) is used at once.
  private readonly healthyUntil = new Map<ProviderName, number>();

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
    // The first provider passed over (skipped or failed) that wasn't known to be paid.
    // Once there is one, the hard rule applies: no paid provider without
    // DARKROOM_ALLOW_PAID_FALLBACK.
    let freePassed: { name: ProviderName; how: "was skipped" | "failed" } | undefined;

    for (const name of candidates) {
      const provider = this.providers.get(name);
      if (!provider) {
        skipped.push({ provider: name, reason: "not available in this version of Darkroom yet" });
        if (!PAID_PROVIDERS.has(name)) freePassed ??= { name, how: "was skipped" };
        continue;
      }
      if (provider.isPaid && freePassed && !this.config.allowPaidFallback) {
        skipped.push({
          provider: name,
          reason:
            `not used because ${freePassed.name} ${freePassed.how} and this provider costs money; ` +
            "DARKROOM_ALLOW_PAID_FALLBACK=true allows this",
        });
        continue;
      }
      const health = await this.health(name, provider);
      if (!health.ok) {
        skipped.push({ provider: name, reason: `unhealthy: ${health.detail ?? "health check failed"}` });
        if (!provider.isPaid) freePassed ??= { name, how: "was skipped" };
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
        this.healthyUntil.delete(name);
        // A refused prompt is never shopped to another (possibly paid) provider, a
        // cancel means stop, and an explicit provider choice has no fallback.
        if (err instanceof ContentRefusedError || opts.signal.aborted || opts.provider) throw err;
        log("warn", "provider failed", { provider: name, error: errorMessage(err) });
        skipped.push({ provider: name, reason: `failed: ${errorMessage(err)}` });
        if (!provider.isPaid) freePassed ??= { name, how: "failed" };
        continue;
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

  /** A built provider from the configured order, if there is one by that name. */
  provider(name: ProviderName): ImageProvider | undefined {
    return this.providers.get(name);
  }

  /** The provider's health, reusing a healthy result for HEALTH_CACHE_MS. A check that throws counts as unhealthy. */
  async health(name: ProviderName, provider: ImageProvider): Promise<{ ok: boolean; detail?: string }> {
    if ((this.healthyUntil.get(name) ?? 0) > Date.now()) return { ok: true };
    const health = await provider.healthCheck().catch((err: unknown) => ({ ok: false, detail: errorMessage(err) }));
    if (health.ok) this.healthyUntil.set(name, Date.now() + HEALTH_CACHE_MS);
    return health;
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
