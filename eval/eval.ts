import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { ConfigError, optional, outputDir, PAID_PROVIDERS, PROVIDER_NAMES, usd, type ProviderName } from "../src/config.js";
import { formatUsd } from "../src/ledger.js";
import { ASPECT_RATIOS, QUALITIES, type GenerateRequest, type Quality } from "../src/providers/types.js";
import type { Router } from "../src/router.js";
import { isErrno, type Storage } from "../src/storage.js";

// The eval: a fixed set of prompts run against every enabled provider, for a person
// to compare side by side (no automatic scoring). Paid calls go through the real
// router and a ledger of the eval's own, capped by DARKROOM_EVAL_BUDGET_USD. Results
// are cached by prompt, aspect ratio, provider, model, and quality, so rebuilding
// the report or rerunning after a failure never pays twice. See "Testing and eval" in SPEC.md.

export const THUMB_MAX_EDGE = 320;

const PromptSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a slug like 'bakery-sign'"),
  category: z.enum(["text", "people", "object", "icon", "scene"]),
  aspect_ratio: z.enum(ASPECT_RATIOS),
  prompt: z.string().min(1).max(4000),
});
export type EvalPrompt = z.infer<typeof PromptSchema>;

const PromptsSchema = z
  .array(PromptSchema)
  .min(1)
  .refine((ps) => new Set(ps.map((p) => p.id)).size === ps.length, "prompt ids must be unique");

const RunKey = z.object({
  prompt_id: z.string(),
  prompt: z.string(),
  aspect_ratio: z.enum(ASPECT_RATIOS),
  provider: z.enum(PROVIDER_NAMES),
  model: z.string(),
  quality: z.enum(QUALITIES),
  created_at: z.string(),
});

const ResultSchema = z.discriminatedUnion("ok", [
  RunKey.extend({
    ok: z.literal(true),
    image: z.string().describe("File name in the eval output directory"),
    thumb: z.string().describe("Path relative to eval/"),
    width: z.number().int(),
    height: z.number().int(),
    seed: z.number().int().nullable(),
    latency_ms: z.number().int(),
    cost_usd: z.number(),
    cost_is_estimate: z.boolean(),
  }),
  RunKey.extend({ ok: z.literal(false), error: z.string() }),
]);
export type EvalResult = z.infer<typeof ResultSchema>;

const ResultsFileSchema = z.object({ version: z.literal(1), results: z.array(ResultSchema) });

/** A provider the eval runs, with the model it reports before generating anything. */
export interface EvalColumn {
  provider: ProviderName;
  model: string;
  isPaid: boolean;
}

export interface EvalConfig {
  budgetUsd: number;
  quality: Quality;
  outputDir: string;
}

const EvalEnvSchema = z.object({
  DARKROOM_EVAL_BUDGET_USD: optional(usd),
  DARKROOM_EVAL_QUALITY: optional(z.enum(QUALITIES, { error: `must be one of: ${QUALITIES.join(", ")}` })),
  DARKROOM_EVAL_OUTPUT_DIR: optional(outputDir),
});

export function loadEvalConfig(env: NodeJS.ProcessEnv = process.env): EvalConfig {
  const parsed = EvalEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${String(i.path[0] ?? "config")}: ${i.message}`));
  }
  const e = parsed.data;
  return {
    budgetUsd: e.DARKROOM_EVAL_BUDGET_USD ?? 0.5,
    quality: e.DARKROOM_EVAL_QUALITY ?? "final",
    // Kept apart from DARKROOM_OUTPUT_DIR so eval images don't crowd list_images.
    outputDir: e.DARKROOM_EVAL_OUTPUT_DIR ?? join(homedir(), ".darkroom", "eval"),
  };
}

export async function loadPrompts(path: string): Promise<EvalPrompt[]> {
  return PromptsSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function loadResults(path: string): Promise<EvalResult[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return [];
    throw err;
  }
  return ResultsFileSchema.parse(JSON.parse(text)).results;
}

export async function saveResults(path: string, results: EvalResult[]): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ version: 1, results }, null, 2)}\n`);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function matches(r: EvalResult, p: EvalPrompt, col: EvalColumn, quality: Quality): boolean {
  return (
    r.prompt === p.prompt &&
    r.aspect_ratio === p.aspect_ratio &&
    r.provider === col.provider &&
    r.model === col.model &&
    r.quality === quality
  );
}

/** The latest result for this prompt and column, if any. */
export function findResult(
  results: readonly EvalResult[],
  p: EvalPrompt,
  col: EvalColumn,
  quality: Quality,
): EvalResult | undefined {
  return results.findLast((r) => matches(r, p, col, quality));
}

/**
 * The report's columns: each provider with a result for these prompts at this quality,
 * configured now or only cached, in PROVIDER_NAMES order. So rebuilding the report
 * in a shell with another DARKROOM_PROVIDER_ORDER never drops cached results, and a
 * configured provider with none (e.g. skipped as unhealthy) isn't an empty column.
 * A configured provider's model wins when it has results; otherwise the latest cached one.
 */
export function reportColumns(
  configured: readonly EvalColumn[],
  prompts: readonly EvalPrompt[],
  quality: Quality,
  results: readonly EvalResult[],
): EvalColumn[] {
  const hasResults = (col: EvalColumn) => prompts.some((p) => findResult(results, p, col, quality));
  return PROVIDER_NAMES.flatMap((provider) => {
    const current = configured.find((c) => c.provider === provider);
    if (current && hasResults(current)) return [current];
    const cached = results.findLast(
      (r) => r.provider === provider && prompts.some((p) => matches(r, p, { provider, model: r.model, isPaid: false }, quality)),
    );
    return cached ? [{ provider, model: cached.model, isPaid: PAID_PROVIDERS.has(provider) }] : [];
  });
}

/** Prompt and column pairs with no successful result yet: what a run would generate. */
export function pendingRuns(
  prompts: readonly EvalPrompt[],
  columns: readonly EvalColumn[],
  quality: Quality,
  results: readonly EvalResult[],
): { prompt: EvalPrompt; column: EvalColumn }[] {
  return columns.flatMap((column) =>
    prompts.filter((p) => findResult(results, p, column, quality)?.ok !== true).map((prompt) => ({ prompt, column })),
  );
}

/**
 * Where a result's thumbnail goes, relative to eval/. Unique per cache key (a hash
 * covers the model, aspect ratio, and prompt text), so a draft run or a run on
 * another model never overwrites the committed thumbnails the README shows.
 */
export function thumbPath(p: EvalPrompt, col: EvalColumn, quality: Quality): string {
  const hash = createHash("sha256").update([col.model, p.aspect_ratio, p.prompt].join("\0")).digest("hex").slice(0, 8);
  return `thumbs/${p.id}--${col.provider}--${quality}-${hash}.jpg`;
}

export function requestFor(p: EvalPrompt, quality: Quality): GenerateRequest {
  return { prompt: p.prompt, aspectRatio: p.aspect_ratio, quality };
}

export interface RunOptions {
  prompts: readonly EvalPrompt[];
  columns: readonly EvalColumn[];
  quality: Quality;
  router: Router;
  storage: Storage; // full-size PNGs and sidecars
  reportDir: string; // eval/: thumbnails go in its thumbs/ folder
  results: readonly EvalResult[];
  save: (results: EvalResult[]) => Promise<void>;
  signal: AbortSignal;
  say: (line: string) => void;
}

/**
 * Generates every pending prompt and column pair, one at a time (ComfyUI runs one
 * job at a time anyway), saving results after each so an interrupted run keeps what
 * it finished. A failure is recorded and retried on the next run. Stops at once
 * when `signal` aborts, without recording the cancelled request.
 */
export async function runEval(o: RunOptions): Promise<EvalResult[]> {
  const results = [...o.results];
  const pending = pendingRuns(o.prompts, o.columns, o.quality, results);
  for (const [i, { prompt, column }] of pending.entries()) {
    o.say(`[${i + 1}/${pending.length}] ${column.provider}: ${prompt.id}`);
    const req = requestFor(prompt, o.quality);
    const key = {
      prompt_id: prompt.id,
      prompt: prompt.prompt,
      aspect_ratio: prompt.aspect_ratio,
      provider: column.provider,
      model: column.model,
      quality: o.quality,
      created_at: new Date().toISOString(),
    };
    const started = performance.now();
    let result: EvalResult;
    try {
      const routed = await o.router.generate(req, {
        provider: column.provider,
        signal: o.signal,
        onProgress: (u) => {
          o.say(`    ${u.message}`);
        },
      });
      const latencyMs = Math.round(performance.now() - started);
      const facts = {
        provider: column.provider,
        model: routed.result.model,
        width: routed.result.width,
        height: routed.result.height,
        seed: routed.result.seed,
        latency_ms: latencyMs,
        cost_usd: routed.result.actualCostUsd ?? routed.provider.estimateCostUsd(req),
        cost_is_estimate: routed.result.actualCostUsd === undefined,
      };
      // Same sidecar shape as generate_image, so list_images can read the eval folder too.
      const saved = await o.storage.save(`${prompt.id}-${column.provider}`, routed.result.png, {
        version: 1,
        created_at: key.created_at,
        request: { prompt: prompt.prompt, aspect_ratio: prompt.aspect_ratio, quality: o.quality, provider: column.provider },
        ...facts,
        ignored_params: [],
        skipped_providers: routed.skipped,
        eval_prompt_id: prompt.id,
      });
      const thumb = thumbPath(prompt, column, o.quality);
      await writeThumbnail(routed.result.png, join(o.reportDir, thumb));
      // The record keeps the model it's cached under (the provider's declared model);
      // the sidecar above keeps the one the provider reported.
      result = { ...key, ...facts, model: column.model, ok: true, image: basename(saved.pngPath), thumb };
      o.say(`    ${facts.width}×${facts.height}, ${formatSeconds(latencyMs)}, ${formatCost(facts)}`);
    } catch (err) {
      if (o.signal.aborted) break;
      const error = err instanceof Error ? err.message : String(err);
      result = { ...key, ok: false, error };
      o.say(`    failed: ${error}`);
      // The router's message names the daily cap; here the eval's own budget stands in for it.
      if (error.includes("spend cap reached")) o.say("    (for the eval, the cap is DARKROOM_EVAL_BUDGET_USD)");
    }
    results.push(result);
    await o.save(results);
  }
  return results;
}

async function writeThumbnail(png: Buffer, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await sharp(png)
    .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 78, mozjpeg: true })
    .toFile(path);
}

export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

function formatCost(o: { cost_usd: number; cost_is_estimate: boolean }): string {
  if (o.cost_usd === 0) return "$0";
  return `${formatUsd(o.cost_usd)}${o.cost_is_estimate ? " (est.)" : ""}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Text safe inside a Markdown table cell or an HTML attribute. */
function cell(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\|/g, "&#124;")
    .replace(/\s+/g, " ");
}

/** eval/report.md: a summary per provider, then a thumbnail grid (prompts down, providers across). */
export function buildReport(o: {
  prompts: readonly EvalPrompt[];
  columns: readonly EvalColumn[];
  quality: Quality;
  results: readonly EvalResult[];
  generatedAt: Date;
}): string {
  const lines = [
    "# Darkroom eval",
    "",
    `Generated by \`npm run eval\` on ${o.generatedAt.toISOString().slice(0, 10)}: ${o.prompts.length} prompts at ` +
      `\`${o.quality}\` quality, each run once per provider. There's no automatic scoring; the grid is for a person to judge. ` +
      "Latency is the full request as Darkroom saw it (for ComfyUI, including model loading). Results are cached, so " +
      "rebuilding this report doesn't generate or spend again. Prompts are in `eval/prompts.json`.",
    "",
    "## Summary",
    "",
    "| Provider | Model | Images | Median latency | Total cost | Cost per image |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const col of o.columns) {
    const done = o.prompts
      .map((p) => findResult(o.results, p, col, o.quality))
      .filter((r): r is Extract<EvalResult, { ok: true }> => r?.ok === true);
    const total = done.reduce((sum, r) => sum + r.cost_usd, 0);
    const estimated = done.some((r) => r.cost_is_estimate && r.cost_usd > 0) ? " (est.)" : "";
    const latency = done.length > 0 ? formatSeconds(median(done.map((r) => r.latency_ms))) : "–";
    const cost = col.isPaid ? `${formatUsd(total)}${estimated}` : "$0 (free)";
    const perImage = !col.isPaid ? "$0" : done.length > 0 ? `${formatUsd(total / done.length)}${estimated}` : "–";
    lines.push(
      `| \`${col.provider}\` | \`${cell(col.model)}\` | ${done.length} of ${o.prompts.length} | ${latency} | ${cost} | ${perImage} |`,
    );
  }

  lines.push("", "## Results", "");
  lines.push(`| Prompt | ${o.columns.map((c) => `\`${c.provider}\``).join(" | ")} |`);
  lines.push(`| --- | ${o.columns.map(() => "---").join(" | ")} |`);
  for (const p of o.prompts) {
    const cells = o.columns.map((col) => {
      const r = findResult(o.results, p, col, o.quality);
      if (!r) return "not run";
      if (!r.ok) return `failed: ${cell(r.error.length > 200 ? `${r.error.slice(0, 200)}…` : r.error)}`;
      const caption = `${r.width}×${r.height} · ${formatSeconds(r.latency_ms)} · ${formatCost(r)}`;
      return `<img src="${r.thumb}" width="240" alt="${cell(`${col.provider}: ${p.prompt}`)}"><br><sub>${caption}</sub>`;
    });
    lines.push(`| **${p.id}** (${p.category}, ${p.aspect_ratio})<br>${cell(p.prompt)} | ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}
