# Progress

## Current: M2 — Ledger + first paid provider · status: in progress

| Milestone | Status | Tag |
| --- | --- | --- |
| Spec review and stress test | done | — |
| Spike: local models on ComfyUI | done | — |
| M0: Scaffold and mock | done | `m0` |
| M1: Local generation (Z-Image) | done | `m1` |
| M2: Ledger + first paid provider | in progress | — |
| M3: Router and guardrails | not started | — |
| M4: Ship it | not started | — |

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

## Next up

M2 plan (agreed Oct 2, 2026):

- [ ] Ledger: JSON file in the output dir keyed by UTC date; reserve/settle; in-process mutex; atomic writes; cap check
- [ ] Enablement rules + paid gate in the router (Darkroom key AND in order; no paid after a skipped free provider unless `DARKROOM_ALLOW_PAID_FALLBACK`); reserve → generate → settle
- [ ] `openai` provider (plain fetch, `gpt-image-2.5-flare` default, model and prices in config, actual cost from usage, `moderation_blocked` → `ContentRefusedError`)
- [ ] Provider contract suite (mock always; comfyui/openai behind env flags) + one recorded OpenAI fixture
- [ ] Acceptance: same prompt on mock, comfyui, openai via `provider`; paid request over the cap refused

## Deviations from spec

- **The first paid provider is OpenAI, and it is now the cheaper one** (decided Oct 2, 2026, start of M2). Checked today: `gpt-image-2.5-flare` bills $30/M image output tokens, roughly $0.006 (low) to $0.05 (high) per 1024² image, and accepts any size in multiples of 16. Gemini 3.1 Flash Image is $0.045–$0.067 per image, and its Lite variant is $0.034 at 1K only. The spec called Gemini "cheapest"; SPEC.md's provider table was updated in PR #5 after review.
- **OpenAI `draft` isn't 0.25MP** (M2). OpenAI's minimum image is 655,360 pixels, so `draft` renders at the smallest allowed size (816×816 at 1:1) at `low` quality; `final` uses the shared 1MP sizes at `high`. The spec allows per-provider tier mappings; this one is documented in the README, SPEC, and the tool's `quality` description.
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
- License: `package.json` says `UNLICENSED` for now. Pick one before publishing in M4.

## Log

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
