import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildReport,
  formatSeconds,
  loadEvalConfig,
  loadPrompts,
  loadResults,
  pendingRuns,
  reportColumns,
  runEval,
  saveResults,
  THUMB_MAX_EDGE,
  type EvalColumn,
  type EvalPrompt,
  type EvalResult,
} from "../../eval/eval.js";
import { ConfigError, loadConfig, type ProviderName } from "../../src/config.js";
import { Ledger } from "../../src/ledger.js";
import { createMockProvider } from "../../src/providers/mock.js";
import type { ImageProvider, Quality } from "../../src/providers/types.js";
import { Router } from "../../src/router.js";
import { Storage } from "../../src/storage.js";

const prompts: EvalPrompt[] = [
  { id: "sign", category: "text", aspect_ratio: "3:2", prompt: "a sign that reads OPEN" },
  { id: "icon", category: "icon", aspect_ratio: "1:1", prompt: "a flat app icon | with a pipe" },
];

let dir: string;
let reportDir: string;
let storage: Storage;
let ledger: Ledger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "darkroom-eval-"));
  reportDir = join(dir, "eval");
  storage = await Storage.open(join(dir, "images"));
  ledger = Ledger.inDir(storage.root);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function paidProvider(over: Partial<ImageProvider> = {}): ImageProvider {
  const png = sharp({ create: { width: 64, height: 48, channels: 3, background: "#336699" } }).png().toBuffer();
  return {
    name: "openai",
    model: "gpt-test",
    isPaid: true,
    supports: { negativePrompt: false, seed: false, referenceImage: false },
    estimateCostUsd: () => 0.3,
    healthCheck: () => Promise.resolve({ ok: true }),
    generate: vi.fn(async () => ({ png: await png, model: "gpt-test", width: 64, height: 48, seed: null, actualCostUsd: 0.25 })),
    ...over,
  };
}

function setup(providers: Partial<Record<ProviderName, ImageProvider>>, budgetUsd = 0.5) {
  const names = Object.keys(providers) as ProviderName[];
  const map = new Map(Object.entries(providers) as [ProviderName, ImageProvider][]);
  const config = { ...loadConfig({ DARKROOM_PROVIDER_ORDER: names.join(",") }), dailyCapUsd: budgetUsd };
  const router = new Router(config, map, ledger);
  const columns: EvalColumn[] = names.map((n) => ({ provider: n, model: map.get(n)?.model ?? "", isPaid: map.get(n)?.isPaid ?? false }));
  return { router, columns };
}

function run(o: {
  router: Router;
  columns: EvalColumn[];
  results?: EvalResult[];
  signal?: AbortSignal;
  ps?: EvalPrompt[];
  quality?: Quality;
}) {
  const save = vi.fn<(results: EvalResult[]) => Promise<void>>(() => Promise.resolve());
  const promise = runEval({
    prompts: o.ps ?? prompts,
    columns: o.columns,
    quality: o.quality ?? "draft",
    router: o.router,
    storage,
    reportDir,
    results: o.results ?? [],
    save,
    signal: o.signal ?? new AbortController().signal,
    say: () => undefined,
  });
  return { promise, save };
}

describe("loadEvalConfig", () => {
  it("defaults to a $0.50 budget, final quality, and ~/.darkroom/eval", () => {
    const c = loadEvalConfig({});
    expect(c.budgetUsd).toBe(0.5);
    expect(c.quality).toBe("final");
    expect(c.outputDir).toMatch(/\.darkroom[/\\]eval$/);
  });

  it("rejects a bad budget, quality, or relative output dir without echoing values", () => {
    const bad = () =>
      loadEvalConfig({ DARKROOM_EVAL_BUDGET_USD: "-1", DARKROOM_EVAL_QUALITY: "ultra", DARKROOM_EVAL_OUTPUT_DIR: "out" });
    expect(bad).toThrow(ConfigError);
    expect(bad).toThrow(/DARKROOM_EVAL_BUDGET_USD.*\n.*DARKROOM_EVAL_QUALITY.*\n.*DARKROOM_EVAL_OUTPUT_DIR/);
  });
});

describe("eval/prompts.json", () => {
  it("has 10 prompts covering text, people, objects, an icon, and scenes", async () => {
    const shipped = await loadPrompts(fileURLToPath(new URL("../../eval/prompts.json", import.meta.url)));
    expect(shipped).toHaveLength(10);
    expect(new Set(shipped.map((p) => p.category))).toEqual(new Set(["text", "people", "object", "icon", "scene"]));
  });
});

describe("runEval", () => {
  it("generates each prompt per provider, saving the image, its sidecar, a thumbnail, and results after each", async () => {
    const { router, columns } = setup({ mock: createMockProvider() });
    const { promise, save } = run({ router, columns });
    const results = await promise;

    expect(results).toHaveLength(2);
    expect(save).toHaveBeenCalledTimes(2);
    const [first] = results;
    if (!first?.ok) throw new Error("expected a success");
    expect(first).toMatchObject({ prompt_id: "sign", provider: "mock", model: "mock-placeholder-v1", width: 624, height: 416 });
    expect(first.thumb).toMatch(/^thumbs\/sign--mock--draft-[0-9a-f]{8}\.jpg$/);
    const thumb = await sharp(join(reportDir, first.thumb)).metadata();
    expect(thumb.format).toBe("jpeg");
    expect(Math.max(thumb.width, thumb.height)).toBe(THUMB_MAX_EDGE);

    const files = await readdir(storage.root);
    expect(files).toContain(first.image);
    const sidecar = JSON.parse(await readFile(join(storage.root, first.image.replace(/\.png$/, ".json")), "utf8")) as Record<
      string,
      unknown
    >;
    expect(sidecar).toMatchObject({ provider: "mock", eval_prompt_id: "sign", request: { quality: "draft" } });
  });

  it("doesn't regenerate cached results, but reruns a prompt whose text changed", async () => {
    const mock = createMockProvider();
    const generate = vi.spyOn(mock, "generate");
    const { router, columns } = setup({ mock });
    const first = await run({ router, columns }).promise;
    expect(generate).toHaveBeenCalledTimes(2);

    const again = await run({ router, columns, results: first }).promise;
    expect(generate).toHaveBeenCalledTimes(2);
    expect(again).toEqual(first);

    const edited = prompts.map((p) => (p.id === "icon" ? { ...p, prompt: "a round app icon" } : p));
    expect(pendingRuns(edited, columns, "draft", first).map((r) => r.prompt.id)).toEqual(["icon"]);
    await run({ router, columns, results: first, ps: edited }).promise;
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("records a failure and retries it on the next run", async () => {
    const mock = createMockProvider();
    const real = mock.generate.bind(mock);
    const generate = vi.spyOn(mock, "generate").mockRejectedValueOnce(new Error("out of memory"));
    const { router, columns } = setup({ mock });
    const first = await run({ router, columns }).promise;
    expect(first[0]).toMatchObject({ ok: false, error: "out of memory" });
    expect(first[1]?.ok).toBe(true);

    generate.mockImplementation(real);
    const second = await run({ router, columns, results: first }).promise;
    expect(generate).toHaveBeenCalledTimes(3);
    expect(second.at(-1)).toMatchObject({ prompt_id: "sign", ok: true });
  });

  it("keeps a paid image when its thumbnail can't be written, and rebuilds the thumbnail next run", async () => {
    await mkdir(reportDir, { recursive: true });
    await writeFile(join(reportDir, "thumbs"), "not a folder");
    const openai = paidProvider({ estimateCostUsd: () => 0.01 });
    const { router, columns } = setup({ openai });
    const first = await run({ router, columns, ps: prompts.slice(0, 1) }).promise;
    const [result] = first;
    if (!result?.ok) throw new Error("expected a success");
    expect(await readdir(storage.root)).toContain(result.image);

    await rm(join(reportDir, "thumbs"));
    const second = await run({ router, columns, results: first, ps: prompts.slice(0, 1) }).promise;
    expect(openai.generate).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect((await sharp(join(reportDir, result.thumb)).metadata()).format).toBe("jpeg");
  });

  it("keeps a paid image in the temp folder when it can't be saved, and says where", async () => {
    const openai = paidProvider({ estimateCostUsd: () => 0.01 });
    const { router, columns } = setup({ openai });
    vi.spyOn(storage, "save").mockRejectedValueOnce(new Error("disk full"));
    const [result] = await run({ router, columns, ps: prompts.slice(0, 1) }).promise;
    if (!result || result.ok) throw new Error("expected a failure");
    expect(result.error).toMatch(/couldn't save it .*disk full.*kept at (\S+\.png)/);
    const rescued = /kept at (\S+\.png)/.exec(result.error)?.[1] ?? "";
    expect((await sharp(rescued).metadata()).format).toBe("png");
    await rm(rescued);
  });

  it("stops paid calls at the eval budget, in a ledger of its own", async () => {
    const openai = paidProvider();
    const { router, columns } = setup({ openai }, 0.5);
    const results = await run({ router, columns }).promise;

    expect(openai.generate).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ ok: true, cost_usd: 0.25, cost_is_estimate: false });
    // $0.25 settled + $0.30 estimate for the next call would pass the $0.50 budget.
    expect(results[1]).toMatchObject({ ok: false, error: expect.stringMatching(/spend cap reached/) as unknown });
    // The saved message names the eval's budget, not the daily cap the eval doesn't use.
    expect(JSON.stringify(results[1])).toContain("Raise DARKROOM_EVAL_BUDGET_USD");
    expect(JSON.stringify(results[1])).not.toContain("DARKROOM_DAILY_CAP_USD");
    expect(await ledger.spentTodayUsd()).toBe(0.25);
  });

  it("stops at once on cancel, without recording the cancelled request", async () => {
    const controller = new AbortController();
    const mock = createMockProvider();
    vi.spyOn(mock, "generate").mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error("aborted"));
    });
    const { router, columns } = setup({ mock });
    const { promise, save } = run({ router, columns, signal: controller.signal });
    expect(await promise).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("thumbnails", () => {
  it("are named per quality and model, so another run never overwrites a committed one", async () => {
    const { router, columns } = setup({ mock: createMockProvider() });
    const finals = await run({ router, columns, quality: "final" }).promise;
    const [final] = finals;
    if (!final?.ok) throw new Error("expected a success");
    const before = await readFile(join(reportDir, final.thumb));

    const drafts = await run({ router, columns, results: finals, quality: "draft" }).promise;
    const otherModel = await run({
      router,
      columns: columns.map((c) => ({ ...c, model: "mock-v2" })),
      results: drafts,
      quality: "final",
    }).promise;
    const thumbs = otherModel.filter((r) => r.ok && r.prompt_id === "sign").map((r) => (r.ok ? r.thumb : ""));
    expect(new Set(thumbs).size).toBe(3);
    expect(await readFile(join(reportDir, final.thumb))).toEqual(before);
  });
});

describe("results file", () => {
  it("round-trips, and a missing file means no results", async () => {
    const path = join(dir, "results.json");
    expect(await loadResults(path)).toEqual([]);
    const { router, columns } = setup({ mock: createMockProvider() });
    const results = await run({ router, columns }).promise;
    await saveResults(path, results);
    expect(await loadResults(path)).toEqual(results);
  });

  it("loads the committed eval/results.json", async () => {
    const committed = await loadResults(fileURLToPath(new URL("../../eval/results.json", import.meta.url)));
    expect(committed.filter((r) => r.ok)).toHaveLength(30);
  });

  it.each([
    ["an image path with a parent directory", { image: "../../.ssh/id_ed25519" }],
    ["an absolute image path", { image: "/etc/passwd" }],
    ["an image that isn't a PNG", { image: "notes.txt" }],
    ["a thumb outside thumbs/", { thumb: "../../outside.jpg" }],
    ["a thumb in a subfolder", { thumb: "thumbs/../../outside.jpg" }],
    ["a thumb with markup", { thumb: 'thumbs/x.jpg" onerror="alert(1)' }],
  ])("rejects %s, so a tampered file can't point reads, writes, or the report elsewhere", async (_, bad) => {
    const path = join(dir, "results.json");
    const { router, columns } = setup({ mock: createMockProvider() });
    const [good] = await run({ router, columns, ps: prompts.slice(0, 1) }).promise;
    await writeFile(path, JSON.stringify({ version: 1, results: [{ ...good, ...bad }] }));
    await expect(loadResults(path)).rejects.toThrow(/image|thumb/);
  });
});

describe("buildReport", () => {
  it("summarizes each provider and lays out a thumbnail grid, escaping table syntax", async () => {
    const openai = paidProvider({ generate: vi.fn().mockRejectedValue(new Error("boom | bad")) });
    const { router, columns } = setup({ mock: createMockProvider(), openai });
    const results = await run({ router, columns }).promise;
    const report = buildReport({ prompts, columns, quality: "draft", results, generatedAt: new Date("2026-10-03T12:00:00Z") });

    expect(report).toContain("on 2026-10-03: 2 prompts at `draft` quality");
    expect(report).toMatch(/\| `mock` \| `mock-placeholder-v1` \| 2 of 2 \| [\d.]+s \| \$0 \(free\) \| \$0 \|/);
    expect(report).toContain("| `openai` | `gpt-test` | 0 of 2 | – | $0.00 | – |");
    expect(report).toContain("| Prompt | `mock` | `openai` |");
    expect(report).toMatch(/<img src="thumbs\/sign--mock--draft-[0-9a-f]{8}\.jpg" width="240" alt="mock: a sign that reads OPEN"><br><sub>624×416/);
    expect(report).toContain("a flat app icon &#124; with a pipe");
    expect(report).toContain("failed: boom &#124; bad");
    // Every grid row has one cell per column, so no stray pipes split a cell.
    const rows = report.split("\n").filter((l) => l.startsWith("| **"));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.split(" | ")).toHaveLength(3);
  });

  it("says 'not run' for a prompt with no result", () => {
    const columns: EvalColumn[] = [{ provider: "comfyui", model: "z", isPaid: false }];
    const report = buildReport({ prompts, columns, quality: "final", results: [], generatedAt: new Date() });
    expect(report).toContain("| 0 of 2 | – | $0 (free) | $0 |");
    expect(report.match(/not run/g)).toHaveLength(2);
  });
});

describe("reportColumns", () => {
  it("keeps cached providers that aren't configured now, and drops configured ones with no results", async () => {
    const { router, columns } = setup({ mock: createMockProvider(), openai: paidProvider({ estimateCostUsd: () => 0.01 }) });
    const results = await run({ router, columns }).promise;
    const configured: EvalColumn[] = [
      { provider: "comfyui", model: "z-image", isPaid: false }, // e.g. skipped as unhealthy: no results
      { provider: "mock", model: "mock-placeholder-v1", isPaid: false },
    ];

    expect(reportColumns(configured, prompts, "draft", results)).toEqual([
      { provider: "mock", model: "mock-placeholder-v1", isPaid: false },
      { provider: "openai", model: "gpt-test", isPaid: true },
    ]);
    expect(reportColumns(configured, prompts, "final", results)).toEqual([]);
  });

  it("uses the configured model when it has results, otherwise the latest cached one", async () => {
    const { router, columns } = setup({ mock: createMockProvider() });
    const results = await run({ router, columns }).promise;
    const newModel: EvalColumn[] = [{ provider: "mock", model: "mock-v2", isPaid: false }];
    expect(reportColumns(newModel, prompts, "draft", results)).toEqual(columns);
  });
});

describe("formatSeconds", () => {
  it("shows seconds under a minute and minutes after", () => {
    expect(formatSeconds(9_440)).toBe("9.4s");
    expect(formatSeconds(214_600)).toBe("3m 35s");
    expect(formatSeconds(60_000)).toBe("1m 00s");
  });
});
