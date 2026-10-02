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
  actualCostUsd?: number; // from provider usage data, when available
}

export interface ImageProvider {
  name: string;
  isPaid: boolean;
  supports: { negativePrompt: boolean; seed: boolean };
  estimateCostUsd(req: GenerateRequest): number;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  // Maps aspectRatio to the nearest size the provider supports.
  generate(req: GenerateRequest, signal: AbortSignal): Promise<GenerateResult>;
}

// A policy refusal from the provider. Never triggers fallback, so a refused
// prompt is not shopped around to other (possibly paid) providers.
export class ContentRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentRefusedError";
  }
}
