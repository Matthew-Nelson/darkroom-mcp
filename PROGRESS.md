# Progress

## Current: M4 — Ship it · status: in progress

| Milestone | Status | Tag |
| --- | --- | --- |
| Spec review and stress test | done | — |
| Spike: local models on ComfyUI | done | — |
| M0: Scaffold and mock | done | `m0` |
| M1: Local generation (Z-Image) | done | `m1` |
| M2: Ledger + first paid provider | done | `m2` |
| M3: Router and guardrails | done | `m3` |
| M4: Ship it | in progress | — |

Status values: `not started` → `in progress` → `awaiting review` → `done` (only once tagged).

## M0 gates

- [x] `npm run check` passes (94 tests: 88 unit, 6 stdio integration)
- [x] Done when: `claude mcp add` registers the server with `DARKROOM_PROVIDER_ORDER=mock` and Claude Code returns a placeholder image it can see
- [x] Preview payload size measured against Claude Code's MCP output limit
- [x] Matt approved (saw a placeholder image in his own session)
- [x] Tagged `m0`

## M1 gates

- [x] `npm run check` passes (125 tests: 117 unit, 8 stdio integration); `npm run test:comfyui` passes against the real server (3 tests)
- [x] Done when: a real Z-Image `final` image generated from Claude Code at zero cost, saved with its sidecar, without a client timeout
- [x] Done when: health check with the GGUF plugin removed reports a clear, actionable error
- [x] Matt approved (ran the smoke-test checklist locally: all passed)
- [x] Tagged `m1`

## M2 gates

- [x] `npm run check` passes (248 tests); real contract suite passes against OpenAI (`DARKROOM_CONTRACT_OPENAI=1`, 5 tests)
- [x] Done when: the same prompt and aspect ratio run on mock, comfyui, and openai by changing only `provider`
- [x] Done when: a paid request over the cap is refused
- [x] Matt approved PR #5 (after two multi-model reviews; all findings worth fixing were fixed)
- [x] Merged (PR #5) and tagged `m2` (the tag was moved onto the merge of the wrap-up docs PR, at Matt's request)

## M3 gates

- [x] `npm run check` passes (276 tests, after review fixes)
- [x] Done when: with ComfyUI stopped and order `comfyui,openai`, requests fail clearly by default (unhealthy skip doesn't reach the paid provider)
- [x] Done when: they fall back to the paid provider only with `DARKROOM_ALLOW_PAID_FALLBACK=true`
- [x] Done when: a generic `OPENAI_API_KEY` alone enables nothing
- [x] Matt approved and merged PR #7 (after a multi-model review; all 4 Low findings fixed)
- [x] Tagged `m3`

## M4 gates

- [x] `npm run check` passes (288 tests)
- [x] Done when (adapted, see Deviations): a clean install from the packed tarball with one `claude mcp add ... -e DARKROOM_PROVIDER_ORDER=mock -- npx ...` command generates a mock image in under five minutes (19 s)
- [x] Eval run and report committed (20 of 20 images, $0.0999)
- [ ] Demo GIF (Matt records, Claude edits)
- [ ] Matt approved and merged the PR
- [ ] Tagged `m4`

## Next up

- Matt records the demo GIF; trim and convert it, add it to the README.
- Open the M4 PR.

## Deviations from spec

- **No npm publish in M4** (Matt, Oct 3, 2026: the repo stays private, and publishing is undecided). The acceptance test ran against the packed tarball instead (`npm pack`, then `claude mcp add ... -- npx -y -p <tgz> darkroom-mcp` with an empty npm cache), which exercises the same install path. Publishing later is `npm publish` plus swapping the README's command for `npx -y darkroom-mcp`. License: MIT.
- **The eval budget is per UTC day** (M4). The eval keeps its own ledger in `DARKROOM_EVAL_OUTPUT_DIR` (default `~/.darkroom/eval`, apart from the images `list_images` shows), using the same daily-keyed ledger code with `DARKROOM_EVAL_BUDGET_USD` (default $0.50) as the cap. A run that would spend anything stops after printing its estimate unless given `--yes`. The cache key also includes aspect ratio and quality.
- **`tsx` is a new devDependency** (M4), to run `eval/run.ts` straight from the TypeScript sources with the real router. No new runtime dependency.
- **Only healthy results are cached for 60s** (M3). SPEC says "health check cached for 60s". Caching a failure would leave ComfyUI skipped for up to a minute after it's started; checks are cheap, so unhealthy providers are rechecked on every call. A failed `generate` also drops the provider's cached result.
- **Which failures fall back** (M3): anything except a `ContentRefusedError`, the caller's own cancel, or a failure of an explicitly chosen provider (which is returned as is). Each failure is listed in `skipped_providers` as `failed: <reason>`.
- **One PR per milestone** (decided Oct 2, 2026, start of M3). Replaces one PR per slice; the slices are now single-idea commits inside the milestone's PR. `CLAUDE.md` and SPEC.md updated.
- **Additions to the `list_*` tools** (M3). `list_providers` also lists providers that aren't enabled or built yet (with how to enable them), gives estimates for a square `draft` and `final`, and notes when a paid provider behind a free one is only used by name. `list_images` also returns the sidecar path, model, quality, aspect ratio, size, and seed (so a draft can be rendered as final later), plus `total` and `unreadable` counts. `ImageProvider` gained a `model` field so `list_providers` can name models before anything is generated.
- **The first paid provider is OpenAI, and it is now the cheaper one** (decided Oct 2, 2026, start of M2). Checked today: `gpt-image-2.5-flare` bills $30/M image output tokens, roughly $0.006 (low) to $0.05 (high) per 1024² image, and accepts any size in multiples of 16. Gemini 3.1 Flash Image is $0.045–$0.067 per image, and its Lite variant is $0.034 at 1K only. The spec called Gemini "cheapest"; SPEC.md's provider table was updated in PR #5 after review.
- **OpenAI `draft` isn't 0.25MP** (M2). OpenAI's minimum image is 655,360 pixels, so `draft` renders at the smallest allowed size (816×816 at 1:1) at `low` quality; `final` uses the shared 1MP sizes at `medium` (Matt chose `medium` over `high` after the benchmark: `high` cost ~10× `low` for little visible gain). The spec allows per-provider tier mappings; this one is documented in the README, SPEC, and the tool's `quality` description.
- **Paid-provider rates live in code, not env vars** (M2). SPEC said prices "live in config". The model is configurable (`DARKROOM_OPENAI_MODEL`), but per-token rates are a one-line-per-model table at the top of `openai.ts`, and an unknown model fails startup. Env vars for rates would let a typo silently under-reserve against the cap. SPEC.md updated.
- **`config.ts` lists which providers are paid** (`PAID_PROVIDERS`), so the paid gate knows a not-yet-built `gemini` is paid. The contract suite checks every built provider's `isPaid` against it.
- **The paid gate for skipped free providers lands in M2, not M3.** Once a paid provider can run, the stub router's unhealthy-skip would otherwise reach it. Fallback on failure stays in M3.
- **`ImageProvider.generate` takes an optional third argument, `onProgress`** (M1). Providers report state changes ("Queued in ComfyUI", "Sampling step 3/8"); the tool turns them into MCP progress notifications with a 5s heartbeat. `progress` is elapsed seconds, since MCP requires it to increase and no provider knows the total time.
- **Provider factories can be async, and a missing `COMFYUI_WORKFLOW` template fails startup** (M1), matching "fail fast" for config.
- **The ComfyUI template's output node is `PreviewImage`** (ComfyUI's temp folder), not `SaveImage`, so `DARKROOM_OUTPUT_DIR` holds the only permanent copy.
- **The mapping file's model filenames are written into the graph at request time**, so the map is the source of truth; a test keeps the template's copies in sync so it still loads in ComfyUI as-is.
- **Cancellation is targeted:** dequeue our job (`POST /queue {delete}`), then `POST /interrupt {prompt_id}` only if `/queue` shows our job running. A bare `/interrupt` would stop another client's job.
- **`quality` tiers are a pixel budget, not a short edge** (agreed Oct 2, 2026, start of M1). `draft` ≈ 0.25MP, `final` ≈ 1MP, sides rounded to multiples of 16. The short-edge rule made a 16:9 `final` 1824×1024 (1.8× the pixels of a square one), slower and a memory risk on 16GB; diffusion models are trained near 1MP. Mock uses the same sizing. SPEC.md updated.
- **Node 22+ instead of Node 20+** (decided Oct 2, 2026, after M0). Node 20 reached end-of-life in April 2026. `engines` is `>=22.12.0` (vitest 5's floor), CI tests Node 22 and 24, and vitest is 5.x. TypeScript stays on 6.0 because typescript-eslint doesn't support 7 yet.
- **Additions to `generate_image` output:** `sidecar_path`, and `cost_is_estimate` (true when the provider didn't report an actual cost), so "actual vs. estimate" isn't ambiguous. Free providers (`mock`, `comfyui`) report an actual $0, so `cost_is_estimate` is false for them (decided Oct 2, 2026, M1 review).
- **`DARKROOM_OUTPUT_DIR` expands a leading `~/`.** Values in `~/.claude.json` aren't shell-expanded, and `~/...` is absolute in intent. Other relative paths are still rejected.
- **M0 router is a stub:** explicit provider, or the first implemented and healthy one in the order; no fallback on failure, no health caching. Provider names not built yet (comfyui until M1) are skipped with "not available in this version of Darkroom yet", so the default order gives a clear error rather than a startup crash. It also refuses every paid provider until the ledger lands in M2.

## Open questions

- ~~Which paid provider ships in v1?~~ Resolved at the start of M2: OpenAI.
- ~~Does Claude Code reset its MCP tool timeout on progress notifications?~~ Resolved in M1: yes for the idle timeout (30 min for stdio), and the wall-clock default is ~28h. Claude Code sends a `progressToken` on every `tools/call`. Details in SPEC.md under "Timeouts and progress".
- ~~License~~ Resolved at the start of M4: MIT.

## Log

### Oct 3, 2026 (UTC) — M4 built and accepted (GIF pending)

#### Build notes

Built: MIT license, the eval (`eval/`: prompts, harness, CLI, report, cached results, thumbnails; `npm run eval`), package metadata for 0.1.0, README sections (architecture diagram, packaged install, MCP Inspector smoke test, eval, local vs. OpenAI comparison). `tsx` added as a devDependency. Matt's calls at the start: MIT, eval at `final` on comfyui + openai, he records the GIF, repo stays private and no npm publish for now.

**Acceptance run** (adapted for no publish, see Deviations): `npm run build && npm pack`, then in a new scratch project with an empty npm cache (`npm_config_cache` pointed at a new folder) and a scratch output dir:

1. `claude mcp add darkroom -e DARKROOM_PROVIDER_ORDER=mock -e DARKROOM_OUTPUT_DIR=… -e npm_config_cache=… -- npx -y -p <scratch>/darkroom-mcp-0.1.0.tgz darkroom-mcp`
2. `claude -p 'Use the darkroom generate_image tool to make a 16:9 draft image of "a lighthouse on a cliff at dusk". Then, based only on the returned preview, describe what you see…' --allowedTools mcp__darkroom__generate_image`
3. Claude described the placeholder from the preview (dark maroon background, the prompt text, footer "mock · seed 2895557258 · 688×384") and reported the path, `mock`, 688×384, $0. PNG and sidecar were on disk; `claude mcp list` showed ✔ Connected. **19 s** from step 1 to the answer. **Pass.** The registration was removed afterwards.

npx's own install from an empty cache: about 4 s (82 MB downloaded; sharp's prebuilt binary, no compile).

**MCP Inspector** 2.9.0 CLI: `tools/list` listed the three tools; `tools/call generate_image` returned an image block plus the structured result (mock, 688×384). Commands are in the README.

**Eval** (`final`, `~/.darkroom/eval`, eval budget $0.50):

| Provider | Images | Median latency | Range | Cost |
| --- | --- | --- | --- | --- |
| comfyui (Z-Image Turbo Q4_K_M) | 10 of 10 | 4m 06s | 3m 50s to 4m 22s | $0 |
| openai (`gpt-image-2.5-flare`, `medium`) | 10 of 10 | 9.2 s | 8.3 to 10.9 s | $0.0999 |

OpenAI `medium` finals measured $0.0133 square (projected ~$0.013 in M2), $0.0089 at 3:2 or 2:3, $0.0078 at 16:9 or 9:16. All within the $0.021 estimate.

**Spend:** $0.0999 (the OpenAI half of the eval, in the eval's ledger). Nothing else paid.

**Findings:**

- Both models spelled all three test phrases right at `final`. The difference is instruction following: Z-Image drew a lens instead of an aperture, whole cameras instead of a camera taken apart, and "Kraft" printed on a lid instead of a kraft paper label. OpenAI got all three.
- The first ComfyUI final (4m 22s, with model loading and other work on the machine) came within 40 s of the 300 s `COMFYUI_TIMEOUT_MS`. Warm runs were 3m 50s to 4m 12s. No change for now, but a busy machine could hit the default timeout on a `final`.
- `npx <path-to.tgz>` tries to execute the path; a local tarball needs `npx -y -p <tgz> darkroom-mcp`.
- Inspector 2.x's CLI wants the server command before its options (`--cli node dist/index.js -e … --method …`); with options first it looks for a config file and fails.
- Inspector's schema portability check gives 7 warnings, all for nullable fields in `outputSchema` (`"type": ["string", "null"]`). Legal JSON Schema with no effect on Claude Code; left as is.

### Oct 3, 2026 (UTC) — M3 done (tagged `m3`)

Matt approved and PR #7 was merged (merge commit) after the review fixes. Spend for M3: $0.0104 (two OpenAI drafts during acceptance).

### Oct 3, 2026 (UTC) — review of PR #7

A multi-model review of `2ecc14e` posted 4 Low findings inline (nothing Medium or High). All fixed, with a failing test first where code changed:

- **A1:** `list_providers` kept its own provider-to-key-variable table, against the spec's "no provider-specific logic in tools". The map moved to `config.ts` (`API_KEY_VARS`), with a test that it matches `PAID_PROVIDERS` and the variables `loadConfig` reads.
- **B5:** `list_images` counted every read failure as `unreadable` without a trace. A broken sidecar or missing PNG stays quiet; other errors (e.g. EISDIR, EACCES) are now logged to stderr.
- **A2, A7:** a schema description and a test title that no longer matched the code.

Each comment has an inline reply. `npm run check`: 276 tests.

### Oct 3, 2026 (UTC) — M3 built and accepted; awaiting review

#### Build notes

Built: router fallback on failure (the paid gate covers failures as well as skips; refusals, cancels, and explicit providers never fall back), a 60s cache of healthy results, `model` on `ImageProvider`, `list_providers`, `list_images`, README sections for both tools and for fallback. One PR for the milestone, per the new rule in `CLAUDE.md`.

Process notes: `CLAUDE.md` now says one PR per milestone (Matt, start of M3). An `npx prettier` run reformatted the tree mid-M3; it was caught before pushing, the branch was rebuilt without it, and `CLAUDE.md` now says the repo has no formatter. `SPEC.md` now says Gemini gets M2's cost benchmark when it lands after v1 (Matt asked for real Gemini costs).

**Acceptance run** (built `dist/`; each case a fresh headless `claude -p` with `--strict-mcp-config`, a scratch MCP config with `DARKROOM_PROVIDER_ORDER=comfyui,openai`, and only the three Darkroom tools allowed; key from the Keychain through the environment only; prompt "a red bicycle leaning against a brick wall", 1:1 draft, no `provider`):

1. **ComfyUI stopped, flag off.** `list_providers`: comfyui `healthy: false` ("Can't reach ComfyUI at http://127.0.0.1:8188 (ECONNREFUSED)…"); openai `healthy: true` with "Used only when asked for by name: comfyui comes first, and DARKROOM_ALLOW_PAID_FALLBACK is off."; spend $0 of $2. `generate_image` returned: `No image provider could take this request (comfyui: unhealthy: Can't reach ComfyUI at http://127.0.0.1:8188 (ECONNREFUSED). Is it running? Set COMFYUI_URL if it isn't at that address.; openai: not used because comfyui was skipped and this provider costs money; DARKROOM_ALLOW_PAID_FALLBACK=true allows this).` **Pass.**
2. **ComfyUI stopped, `DARKROOM_ALLOW_PAID_FALLBACK=true`.** Served by `openai` / `gpt-image-2.5-flare`, 816×816, 9.4 s, **$0.0052** actual; `skipped_providers` listed comfyui as unhealthy with the same reason. Claude described the preview correctly. `list_providers` then showed $0.0052 spent, $1.9948 remaining. **Pass.**
3. **Generic `OPENAI_API_KEY` only** (the real key, under the generic name; no `DARKROOM_OPENAI_API_KEY`), flag still on. Both the default call and `provider: "openai"` were refused: `openai: unhealthy: DARKROOM_OPENAI_API_KEY is not set. Darkroom ignores a generic OPENAI_API_KEY on purpose, so a key in your shell never spends money by itself`. Spend unchanged. **Pass.**
4. **Extra: failure fallback against a real provider.** ComfyUI running, `COMFYUI_TIMEOUT_MS=15000`, flag on. ComfyUI took the job, timed out, and was interrupted (its log: "Interrupting prompt …", "Processing interrupted"; `/queue` empty right after), then the request went to openai ($0.0052) with `skipped_providers: [{"provider":"comfyui","reason":"failed: ComfyUI didn't finish within 15s (COMFYUI_TIMEOUT_MS, which includes time waiting in ComfyUI's queue). The job was cancelled."}]`. `list_images` (limit 3) listed both new images and the previous comfyui render newest first, 20 total, 0 unreadable. ComfyUI stopped afterward. **Pass.**

`list_images` against the real `~/.darkroom/images` (M0–M2 sidecars): 18 images, 0 unreadable.

**Spend:** two OpenAI drafts, **$0.0104** in the ledger for 2026-10-03 (UTC).

**Findings:**

- With the fallback flag on, Claude volunteered the cost trade-off unprompted ("draft requests will keep going to OpenAI and costing money while ComfyUI is down"), from `skipped_providers` and `list_providers`.
- `--allowedTools` takes a variable number of arguments, so the prompt for `claude -p` has to come before it.

### Oct 2, 2026 — M2 done (tagged `m2`)

Matt approved and PR #5 was merged (merge commit). The first real `medium` final came from Matt's own side-by-side run (`fox-cafe-openai-a651a4cd.png`): 3:2 at 1248×832, 10.8 s, **$0.008875** actual, against a $0.021245 reservation. From the cost, that's about 290 image tokens; scaled by the 3:2-to-square ratio seen for drafts, a `medium` square is ~425 tokens (~$0.013), in line with the third-party ~439. No over-estimate warning; the 700-token estimate stays. Ledger total for the day: $0.1004 (plus ~$0.005 for the contract run outside it). A wrap-up docs PR recorded this, and `m2` was moved onto its merge.

### Oct 2, 2026 — second review of PR #5

A second multi-model review of `e54dcec` posted 6 Low findings inline on PR #5 (nothing Medium or High). Fixed, with failing tests first where code changed:

- **G1:** two sessions writing the shared ledger in the same instant could erase one's fresh reservation, so that call's spend never counted. Settling now restores an erased reservation; the docs describe the race accurately. No cross-process lock (a collision now costs at most one call's amount for a few ms).
- **A5:** the cap-refusal message rounded to cents ("$0.00 of $0.00" for a $0.001 cap); it now shows up to four decimals.
- **A6, A3:** stale wording ("estimated at most"; `high` called the final tier).
- **B1** (deleting the ledger resets the day's spend): documented, not changed. **A2** (deleting the output folder mid-run blocks paid calls until restart): left as is, since it fails closed.

Each comment has an inline reply. `npm run check`: 248 tests.

### Oct 2, 2026 — M2 built, reviewed, benchmarked; awaiting review

#### Build notes

Built: spend ledger (`src/ledger.ts`), paid gate and reserve → generate → settle in the router, `openai` provider, provider contract suite (`test/contract/`), README section on paid generation. All of M2 is one PR, [#5](https://github.com/Matthew-Nelson/darkroom-mcp/pull/5), at Matt's request (it was first split into four stacked PRs, then combined).

Process change mid-M2: the repo moved from committing to `main` to feature branches and reviewed PRs (`CLAUDE.md`, "Branches and PRs").

Docs checked: OpenAI pricing page and image generation guide (`developers.openai.com`), the Images API CLI reference (`POST /images/generations`: sizes, quality, `usage` shape), and Gemini's pricing and image generation docs, for the provider choice.

**Review:** a multi-model review of `4f3ac0b` (`reviews/pr5-4f3ac0b.html`, not committed) verified 9 findings: 1 Medium (a paid image lost if saving failed) and 8 Low. All were fixed in new commits with failing tests first; the mapping is in [the PR comment](https://github.com/Matthew-Nelson/darkroom-mcp/pull/5#issuecomment-5962298030).

**Benchmark and acceptance** (key in the macOS Keychain, passed through the environment; never in config, chat, or files):

1. **Bad key first.** The first call returned HTTP 401: the key had been stored through `security ... -w`'s interactive prompt, which truncates at 128 characters (OpenAI project keys are 164). Nothing was charged; the ledger released the reservation, as designed. README now says to pass the key with `-w "$(pbpaste)"`.
2. **Cost benchmark** through the real router and ledger (cap $0.50), prompt "a ceramic coffee mug on a wooden desk by a window, morning light, the mug reads DARKROOM in bold letters":

   | Request | Size | Time | Image tokens | Actual | Estimate then |
   | --- | --- | --- | --- | --- | --- |
   | draft (low) 1:1 | 816×816 | 9.7 s | 171 | $0.005275 | $0.019485 |
   | final (high) 1:1 | 1024×1024 | 19.0 s | 1,756 | $0.052825 | $0.149058 |
   | final (high) 16:9 | 1360×768 | 14.4 s | 987 | $0.029755 | $0.148505 |

   "DARKROOM" was spelled correctly in all three; the `low` draft looked nearly as good as the `high` square final. Tokens don't follow pixel count (16:9 used 44% fewer than 1:1 at the same pixels). Estimates were recalibrated per tier from these numbers (now about $0.007 draft, $0.066 final; tests pin each at or above the recorded cost and within 1.5×), and the recorded responses replaced the hand-made success fixture.
3. **Real contract suite:** `DARKROOM_CONTRACT_OPENAI=1 npm run test:contract`: 5 passed (one draft, about $0.005, outside the ledger by design).
4. **Same prompt, three providers** (fresh headless Claude Code; MCP config with `DARKROOM_PROVIDER_ORDER=comfyui,mock,openai`, key only in Claude Code's environment, which the server inherited): prompt "a lighthouse on a rocky cliff at dusk, a small sign at the gate reads DARKROOM", 3:2 draft, only `provider` changed.

   | provider | model | size | latency | cost |
   | --- | --- | --- | --- | --- |
   | mock | mock-placeholder-v1 | 624×416 | 47 ms | $0 |
   | comfyui | z-image-turbo-q4_k_m | 624×416 | 100 s | $0 |
   | openai | gpt-image-2.5-flare | 992×672 | 8 s | $0.00366 (actual) |

   From the previews, Claude read the sign as "DARKOOM" on comfyui (draft size) and "DARKROOM" on openai. **Pass.**
5. **Over the cap:** same setup with `DARKROOM_DAILY_CAP_USD=0.01`, `provider: "openai"`. Claude quoted: `No image provider could take this request (openai: daily spend cap reached: $0.09 of $0.01 already spent or reserved today (UTC), and this request needs about $0.0195. Raise DARKROOM_DAILY_CAP_USD, or wait for the UTC day to roll over).` The ledger file was byte-for-byte unchanged. **Pass.**

**Spend:** $0.0915 in the ledger (one released 401, four settled calls) plus about $0.005 for the contract run: about **$0.097** in total, against an agreed budget of $0.25.

**Findings:**

- OpenAI is fast (8–19 s versus 100 s for a local draft) and spelled the test word right every time; Z-Image misspelled it once at draft size.
- The response includes an undocumented `data[].generation_id`; `revised_prompt` is absent for these models.
- Claude Code passes its own environment to stdio MCP servers, so keys can stay out of `~/.claude.json`.
- **Decision (Matt, after viewing the images): `final` uses `medium`, not `high`.** `high` cost ~10× the `low` draft for little visible gain. `medium` wasn't measured; its estimate (700 tokens, ~$0.021) is set above the third-party count of ~439 tokens for a square (that source was exact on our `high` square, 1,756 tokens, and close on `low`, 196 vs. 171), and the router warns if a real cost exceeds it. Benchmark images: `~/.darkroom/benchmark-m2/`.

### Oct 2, 2026 — post-M1 fixes from the baseline review

A multi-model review of the M1 code (`reviews/baseline-m1-6e51a21.html`, not committed) verified two Medium findings, both fixed here with a failing test first:

- A websocket frame that parses to `null` crashed the whole server: the listener read `msg.data` outside the `JSON.parse` try/catch, and listener errors are uncaught. Non-object frames are now dropped.
- `COMFYUI_TIMEOUT_MS` had no upper bound. Node clamps timers above 2^31 − 1 ms to 1 ms, so a huge value failed every request at once. Config now rejects values above 2147483647.

`npm run check` passes (127 tests). The review's Low findings (mostly the cancel path overstating what it stopped) are not addressed yet.

### Oct 2, 2026 — M1 done (tagged `m1`)

Matt approved after running the M1 smoke-test checklist locally (draft, draft → final, variation, progress, Esc cancel stopping the GPU job, ComfyUI stopped with default and explicit provider, timeout, missing plugin, `npm run test:comfyui`): all passed. Review change: free providers now report an actual $0 (`cost_is_estimate: false`).

#### Build notes

Built: `quality` tiers by pixel count; `workflows/zimage.json` + `zimage.map.json` with a zod-validated loader; `comfyui` provider (submit, poll, fetch, actual size from the PNG, timeout including queue wait, targeted cancel, health check via `/system_stats` + `/object_info`, websocket step progress); MCP progress notifications in `generate_image`; offline fixtures recorded from ComfyUI 0.38.0 (`test/fixtures/comfyui/`); `npm run test:comfyui`; README section on local setup.

Docs checked: ComfyUI 0.38.0 source on this machine (`server.py`: client-chosen `prompt_id`, targeted `/interrupt`, `/queue` delete, `/api/jobs/{id}/cancel`; websocket `progress` messages go only to the submitting `client_id`); MCP SDK 1.31 client (`DEFAULT_REQUEST_TIMEOUT_MSEC` 60s, `resetTimeoutOnProgress` opt-in); Claude Code docs (`mcp.md`, `env-vars.md`) for tool timeouts.

**Acceptance run:**

1. Re-registered: `claude mcp add darkroom -e DARKROOM_PROVIDER_ORDER=comfyui,mock -- node "$PWD/dist/index.js"` (local scope; ✔ Connected).
2. **Final image.** Fresh headless session, with only the Darkroom tool allowed: `claude -p 'Use the darkroom generate_image tool to make a quality "final", 3:2 image of: "a ceramic coffee mug on a wooden desk by a window, morning light, the mug reads DARKROOM in bold letters". Do not pass provider. ...'`. Result: `comfyui` / `z-image-turbo-q4_k_m`, 1248×832, seed 2788901362, 234,414 ms (3m54s), $0, nothing skipped. Saved `~/.darkroom/images/a-ceramic-coffee-mug-on-a-wooden-desk-by-a-window-morning-2a0f88d0.png` (1.9 MB) plus its sidecar. From the preview, Claude described a white mug on a wooden desk by a window with "DARKROOM" spelled correctly. Claude Code's debug log showed "still running" every 30s and then "completed successfully in 3m 54s", with no timeout. **Pass.**
3. **Progress token.** Wrapped the server in `tee` to record Claude Code's requests: `tools/call` carries `"_meta":{"claudecode/toolUseId":"…","progressToken":2}`, so the notifications are delivered.
4. **GGUF plugin removed.** Moved `~/ComfyUI/custom_nodes/ComfyUI-GGUF` out of the folder, restarted ComfyUI, and asked headless Claude Code to generate with `provider: "comfyui"`. It quoted: `No image provider could take this request (comfyui: unhealthy: ComfyUI is missing the UnetLoaderGGUF, CLIPLoaderGGUF nodes: install the ComfyUI-GGUF custom node (https://github.com/city96/ComfyUI-GGUF) into ComfyUI's custom_nodes folder and restart ComfyUI.).` Then put the plugin back and stopped ComfyUI. **Pass.**

**`npm run test:comfyui`** (real server, 2m01s): health ok; 512×512 draft in 98s with steps 1–8 reported; aborting at step 1 left ComfyUI's queue empty within about one sampler step (the GPU stopped).

**Findings:**

- Sampling runs ~10s/step at 512px and ~26s/step at 1024px. Model loading (text encoder on the CPU) is ~10s of each run.
- ComfyUI only sends websocket progress to the `client_id` that submitted the job, so Darkroom opens its own socket per request.
- Node's `fetch` rejects some ports outright ("bad port", e.g. 9). The "can't reach" message now falls back to the cause's message when there's no error code.
- Claude Code logs MCP server stderr only during startup, so server logs after `ready` aren't visible in `~/.claude/debug/`.

### Oct 2, 2026 — M0 done (tagged `m0`)

Matt approved after seeing a placeholder image in his own Claude Code session.

#### Build notes

Built: strict TS scaffold, ESLint, vitest, CI (Node 20/22/24), zod config validation, `ImageProvider` interface, `mock` provider, storage (slug + unique id, realpath pinning, exclusive create, JPEG preview), M0 router, `generate_image` with `outputSchema`, stdio entry point, README.

**Acceptance run:**

1. `npm run build`, then `claude mcp add darkroom -e DARKROOM_PROVIDER_ORDER=mock -- node "$PWD/dist/index.js"` (local scope). `claude mcp get darkroom`: ✔ Connected.
2. Fresh headless session, with only the Darkroom tool allowed so it couldn't read the file from disk: `claude -p 'Use the darkroom generate_image tool to make a 3:2 draft image of "a lighthouse on a cliff at dusk, gulls overhead". Then, based only on the image preview..., describe exactly what you see...'`.
3. Result: Claude called `generate_image` (`aspect_ratio: 3:2`, `quality: draft`) and got a 768×512 PNG saved to `~/.darkroom/images/a-lighthouse-on-a-cliff-at-dusk-gulls-overhead-645745db.png` plus its sidecar, in 187 ms, $0. From the preview alone it described a flat dark purple background, quoted the prompt text verbatim, and read the footer `mock · seed 89944026 · 768×512`, which matches the tool's seed. **Pass.**

**Preview payload vs. Claude Code's MCP output limit:**

- Claude Code's limit is `MAX_MCP_OUTPUT_TOKENS` (default 25,000; warns above 10,000). The docs don't say how image blocks count.
- Preview sizes (JPEG q80, max 768px): the mock draft is 9 KB (12,132 base64 chars). Real renders from the spike (Z-Image, Flux, SDXL at 1024px, previewed at 768×768) are 33–46 KB (45–63K base64 chars), which would be 11–16K tokens if counted as chars/4.
- Probe: a throwaway server returned the worst case (SDXL, 62,752 base64 chars) to `claude -p`, at the default limit and with `MAX_MCP_OUTPUT_TOKENS=2000`. Both times the image arrived intact with no warning or truncation, and Claude described it correctly. **So image blocks aren't counted by base64 length; a 768px preview has at least 8× headroom.** No change to the 768px cap needed.

**Findings:**

- **Claude Code shows the model `structuredContent` (as JSON) instead of the tool's text blocks** when both are present. The readable summary in the text block only reaches other clients. Anything Claude must see (skip reasons, warnings, guidance) has to live in `structuredContent`.
- Claude Code saves each returned image under `~/.claude/projects/<project>/tool-results/` and adds an `[Image: source: <path>]` text block next to it.

### Oct 2, 2026 — spec review and local model spike

- Stress-tested the spec and revised it: closed paid-spend loopholes, moved the ledger/cap before the first paid call, swapped `width`/`height` for `aspect_ratio`, cut v1 to mock + comfyui + one paid provider.
- Installed ComfyUI at `~/ComfyUI` and timed SDXL, Flux schnell, and Z-Image Turbo on the M3/16GB. Chose **Z-Image Turbo** as the default local model (best text rendering). Results, model sources, and findings are in `SPEC.md` under "Local model spike results".
- Spec changes from the spike: `quality: draft | final`, 300s ComfyUI timeout, required progress notifications, template mapping files listing model files, seed-variety guidance for Z-Image.
- Set up `CLAUDE.md`, this file, and `scripts/bench-comfyui.py`.
