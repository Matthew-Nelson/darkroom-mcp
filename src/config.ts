import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { z } from "zod";

// Every provider Darkroom knows about. A name can be valid in config before its
// provider ships; the router reports it as unavailable instead of failing startup.
export const PROVIDER_NAMES = ["mock", "comfyui", "openai", "gemini"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface Config {
  outputDir: string;
  providerOrder: ProviderName[];
  dailyCapUsd: number;
  allowPaidFallback: boolean;
  comfyui: { url: string; workflow: string; timeoutMs: number };
  openai: { apiKey: string | undefined; model: string; timeoutMs: number };
  gemini: { apiKey: string | undefined };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid Darkroom configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

// Empty strings count as unset: `claude mcp add -e FOO=` and blank .env lines are common.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

const outputDir = z
  .string()
  .transform((p) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p))
  .refine(isAbsolute, "must be an absolute path (relative paths depend on the client's working directory)")
  .transform((p) => normalize(p));

const providerOrder = z
  .string()
  .transform((s) => s.split(",").map((p) => p.trim().toLowerCase()))
  .pipe(
    z
      .array(z.enum(PROVIDER_NAMES, { error: `each provider must be one of: ${PROVIDER_NAMES.join(", ")}` }))
      .min(1, "must list at least one provider")
      .refine((names) => new Set(names).size === names.length, "must not list a provider twice"),
  );

// zod rejects NaN and Infinity as invalid numbers.
const usd = z.coerce.number({ error: "must be a number" }).min(0, "must be zero or more");

const bool = z.enum(["true", "false"], { error: 'must be "true" or "false"' }).transform((v) => v === "true");

const httpUrl = z
  .url({ protocol: /^https?$/, error: "must be an http(s) URL" })
  .transform((u) => u.replace(/\/+$/, ""));

const workflowName = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "must be a template name like 'zimage'");

// Node's timers clamp anything above 2^31 - 1 ms to 1 ms, which would time out every request at once.
const timeoutMs = z.coerce
  .number({ error: "must be a number" })
  .int("must be a whole number")
  .min(1000, "must be at least 1000")
  .max(2_147_483_647, "must be at most 2147483647 (about 24.8 days)");

// The provider checks the name against its price table at startup.
const openaiModel = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "must be a model name like 'gpt-image-2.5-flare'");

// API keys: only presence is checked, and their values never appear in errors.
const apiKey = z.string();

const EnvSchema = z.object({
  DARKROOM_OUTPUT_DIR: optional(outputDir),
  DARKROOM_PROVIDER_ORDER: optional(providerOrder),
  DARKROOM_DAILY_CAP_USD: optional(usd),
  DARKROOM_ALLOW_PAID_FALLBACK: optional(bool),
  COMFYUI_URL: optional(httpUrl),
  COMFYUI_WORKFLOW: optional(workflowName),
  COMFYUI_TIMEOUT_MS: optional(timeoutMs),
  DARKROOM_OPENAI_API_KEY: optional(apiKey),
  DARKROOM_OPENAI_MODEL: optional(openaiModel),
  DARKROOM_OPENAI_TIMEOUT_MS: optional(timeoutMs),
  DARKROOM_GEMINI_API_KEY: optional(apiKey),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Issue messages are built from the rules above and never include the input value.
    const problems = parsed.error.issues.map((issue) => `${String(issue.path[0] ?? "config")}: ${issue.message}`);
    throw new ConfigError([...new Set(problems)]);
  }
  const e = parsed.data;
  return {
    outputDir: e.DARKROOM_OUTPUT_DIR ?? join(homedir(), ".darkroom", "images"),
    providerOrder: e.DARKROOM_PROVIDER_ORDER ?? ["comfyui"],
    dailyCapUsd: e.DARKROOM_DAILY_CAP_USD ?? 2,
    allowPaidFallback: e.DARKROOM_ALLOW_PAID_FALLBACK ?? false,
    comfyui: {
      url: e.COMFYUI_URL ?? "http://127.0.0.1:8188",
      workflow: e.COMFYUI_WORKFLOW ?? "zimage",
      timeoutMs: e.COMFYUI_TIMEOUT_MS ?? 300_000,
    },
    openai: {
      apiKey: e.DARKROOM_OPENAI_API_KEY,
      model: e.DARKROOM_OPENAI_MODEL ?? "gpt-image-2.5-flare",
      timeoutMs: e.DARKROOM_OPENAI_TIMEOUT_MS ?? 180_000,
    },
    gemini: { apiKey: e.DARKROOM_GEMINI_API_KEY },
  };
}
