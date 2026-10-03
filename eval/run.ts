import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "../src/config.js";
import { formatUsd, Ledger } from "../src/ledger.js";
import { createProviders } from "../src/providers/registry.js";
import { Router } from "../src/router.js";
import { Storage } from "../src/storage.js";
import {
  buildReport,
  loadEvalConfig,
  loadPrompts,
  loadResults,
  pendingRuns,
  requestFor,
  runEval,
  saveResults,
  type EvalColumn,
} from "./eval.js";

// npm run eval                 shows the plan; generates if nothing in it costs money
// npm run eval -- --yes        also spends money on paid providers (within DARKROOM_EVAL_BUDGET_USD)
// npm run eval -- --report     only rebuilds eval/report.md from cached results
// Providers come from DARKROOM_PROVIDER_ORDER, with the usual Darkroom keys and settings.

const EVAL_DIR = fileURLToPath(new URL(".", import.meta.url));
const RESULTS_PATH = join(EVAL_DIR, "results.json");
const FLAGS = new Set(["--yes", "--report"]);

const say = (line: string) => {
  process.stderr.write(`${line}\n`);
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !FLAGS.has(a));
  if (unknown.length > 0) throw new Error(`Unknown option ${unknown.join(" ")}. Options: --yes, --report.`);

  const config = loadConfig();
  const evalConfig = loadEvalConfig();
  const prompts = await loadPrompts(join(EVAL_DIR, "prompts.json"));
  let results = await loadResults(RESULTS_PATH);
  const providers = await createProviders(config);
  const columns: EvalColumn[] = [];
  for (const name of config.providerOrder) {
    const provider = providers.get(name);
    if (provider) columns.push({ provider: name, model: provider.model, isPaid: provider.isPaid });
    else say(`Skipping ${name}: not available in this version of Darkroom yet.`);
  }

  if (!args.includes("--report")) {
    const storage = await Storage.open(evalConfig.outputDir);
    // The eval keeps its own ledger and cap, apart from DARKROOM_DAILY_CAP_USD and the
    // day's interactive spend, and an explicit provider per request means no fallback.
    const ledger = Ledger.inDir(storage.root);
    const router = new Router({ ...config, dailyCapUsd: evalConfig.budgetUsd, allowPaidFallback: false }, providers, ledger);

    const runnable: EvalColumn[] = [];
    for (const col of columns) {
      const provider = providers.get(col.provider);
      const health = provider ? await router.health(col.provider, provider) : { ok: false };
      if (health.ok) runnable.push(col);
      else say(`Skipping ${col.provider}: unhealthy: ${health.detail ?? "health check failed"}`);
    }

    const pending = pendingRuns(prompts, runnable, evalConfig.quality, results);
    let estimateUsd = 0;
    for (const col of runnable) {
      const mine = pending.filter((p) => p.column === col);
      const provider = providers.get(col.provider);
      const cost = mine.reduce((sum, p) => sum + (provider?.estimateCostUsd(requestFor(p.prompt, evalConfig.quality)) ?? 0), 0);
      estimateUsd += cost;
      const price = col.isPaid ? `about ${formatUsd(cost)} at most` : "free";
      say(`${col.provider} (${col.model}): ${mine.length} of ${prompts.length} to generate, ${price}`);
    }
    const spent = await ledger.spentTodayUsd();
    say(
      `Quality: ${evalConfig.quality}. Eval budget: ${formatUsd(evalConfig.budgetUsd)} per UTC day ` +
        `(DARKROOM_EVAL_BUDGET_USD), ${formatUsd(spent)} spent today. Images: ${storage.root}`,
    );

    if (estimateUsd > evalConfig.budgetUsd - spent) {
      say("The estimate is more than the budget left today, so some paid requests will be refused. They're retried on the next run.");
    }
    if (pending.length === 0) {
      say("Nothing to generate: every prompt has a cached result.");
    } else if (estimateUsd > 0 && !args.includes("--yes")) {
      say(`This run costs money (about ${formatUsd(estimateUsd)} at most). Rerun with \`npm run eval -- --yes\` to go ahead.`);
      process.exitCode = 1;
      return;
    } else {
      const controller = new AbortController();
      process.once("SIGINT", () => {
        say("Cancelling the current request…");
        controller.abort();
      });
      results = await runEval({
        prompts,
        columns: runnable,
        quality: evalConfig.quality,
        router,
        storage,
        reportDir: EVAL_DIR,
        results,
        save: (r) => saveResults(RESULTS_PATH, r),
        signal: controller.signal,
        say,
      });
      say(`Eval spend today: ${formatUsd(await ledger.spentTodayUsd())} of ${formatUsd(evalConfig.budgetUsd)}.`);
    }
  }

  const report = buildReport({ prompts, columns, quality: evalConfig.quality, results, generatedAt: new Date() });
  await writeFile(join(EVAL_DIR, "report.md"), report);
  say("Wrote eval/report.md");
}

main().catch((err: unknown) => {
  say(err instanceof ConfigError ? err.message : `Eval failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
