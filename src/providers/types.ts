export const ASPECT_RATIOS = ["1:1", "3:2", "2:3", "16:9", "9:16"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const QUALITIES = ["draft", "final"] as const;
export type Quality = (typeof QUALITIES)[number];

export interface GenerateRequest {
  prompt: string;
  negativePrompt?: string;
  aspectRatio: AspectRatio;
  quality: Quality;
  seed?: number;
}

export interface GenerateResult {
  png: Buffer; // normalized to PNG via sharp
  model: string;
  width: number; // actual output size
  height: number;
  seed: number | null; // null when the provider has no seed control
  actualCostUsd?: number; // from provider usage data when available; 0 for free providers
}

// What a provider is doing right now, e.g. "Sampling step 3/8". The tool turns
// these into MCP progress notifications; providers just report state changes.
export interface ProgressUpdate {
  message: string;
  step?: number;
  totalSteps?: number;
}
export type ProgressListener = (update: ProgressUpdate) => void;

export interface ImageProvider {
  name: string;
  isPaid: boolean;
  supports: { negativePrompt: boolean; seed: boolean };
  estimateCostUsd(req: GenerateRequest): number;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  // Maps aspectRatio to the nearest size the provider supports.
  // Must stop the provider's work (not just stop waiting) when `signal` aborts.
  generate(req: GenerateRequest, signal: AbortSignal, onProgress?: ProgressListener): Promise<GenerateResult>;
}

// A provider failure. `notCharged: true` means the request certainly cost
// nothing (e.g. rejected before generation), so the router releases its spend
// reservation; any other failure of a paid call keeps the reservation, on the
// assumption that the provider may have charged.
export class ProviderError extends Error {
  readonly notCharged: boolean;

  constructor(message: string, opts: { notCharged?: boolean } = {}) {
    super(message);
    this.name = "ProviderError";
    this.notCharged = opts.notCharged ?? false;
  }
}

// A policy refusal from the provider. Never triggers fallback, so a refused
// prompt is not shopped around to other (possibly paid) providers.
export class ContentRefusedError extends ProviderError {
  constructor(message: string, opts: { notCharged?: boolean } = {}) {
    super(message, opts);
    this.name = "ContentRefusedError";
  }
}
