# Darkroom MCP — Goals & Build Spec

Oct 2, 2026 · @Matt

## Overview

Darkroom is a TypeScript MCP server that gives Claude Code an image generation tool through swappable providers: a free local model (Flux or SDXL via ComfyUI) by default, with OpenAI and Gemini as paid options. Claude writes the prompt, calls the tool, sees the returned image, and iterates; Darkroom handles routing, fallback, spend limits, and saving files with metadata.

It is both a tool Matt will actually use and a resume project that demonstrates MCP, provider abstraction, cost guardrails, and testing discipline.

## Goals and non-goals

The v1 bar is three working tools, four providers behind one interface, and a published package someone else can install in under five minutes.

**Goals**

1. Generate images from Claude Code with zero per-image cost by default, using a local model.
2. Swap providers with one config change and no code change; adding a fifth provider means one new file.
3. Never spend money silently: paid providers are opt-in, with a daily spend cap and a cost estimate on every result.
4. Return the image to Claude so it can critique and refine its own output.
5. Ship resume-grade: tests, a small eval report, a README with a demo GIF, and an npm package.
6. Have fun and keep scope tight: v1 in roughly two weekends.

**Non-goals for v1**

- Image editing, inpainting, or image-to-image (Phase 2).
- Remote or hosted deployment (Phase 2, on AWS).
- A web UI or gallery.
- Training or fine-tuning models.
- Calling Claude from inside the server; Claude is the client, not a dependency.

## Architecture

&#91;embedded content: Darkroom architecture · 1 server, 4 providers\]

Claude Code talks to Darkroom over stdio. The router sends each request to the first healthy provider in the configured order, then storage saves the PNG and its sidecar and returns a preview Claude can see. Providers never call each other or the router; each is one file behind the `ImageProvider` interface.

## MCP tools

v1 exposes exactly three tools; anything more waits for Phase 2.

| Tool | Inputs | Returns |
| --- | --- | --- |
| `generate_image` | `prompt` (required), `negative_prompt`, `width`/`height` (default 1024x1024), `provider` (optional override), `seed`, `filename` | An MCP image content block (a downscaled preview, max 768px on the long edge, for Claude to see) plus text with the absolute file path, provider, model, seed, latency in ms, and estimated cost in USD |
| `list_providers` | none | Each provider's name, model, enabled/healthy status, whether it costs money, cost per image, and today's spend vs. the cap |
| `list_images` | `limit` (default 20), `provider` filter | Recent generations from the metadata sidecars: path, prompt, provider, timestamp, cost |

Every saved image gets a JSON sidecar next to it (`image.png` + `image.json`) holding the full request, the resolved provider and model, seed, latency, cost, and timestamp. Tool descriptions must be written for the model: say when to use the tool, that local generation is the default, and that results come back as viewable images.

## Providers

Four providers ship in v1, each a single file implementing the `ImageProvider` interface. Model names and prices below are starting points; the agent must verify them against current provider docs before coding, and all of them live in config, not code.

| Provider | Cost | How it works | Notes |
| --- | --- | --- | --- |
| `comfyui` (default) | Free | HTTP to a local ComfyUI server: POST a workflow JSON to `/prompt`, poll `/history/{id}`, fetch bytes from `/view` | Ship a Flux workflow template and an SDXL template in `workflows/`, with prompt, size, and seed injected by node ID. Slow on Apple Silicon; set a 180s timeout. |
| `openai` | Paid, about $0.04 to $0.17 per image depending on quality | OpenAI Images API with a gpt-image model | Best typography and instruction following. |
| `gemini` | Paid, about $0.04 to $0.07 per image | Gemini API with a Flash Image model | Cheapest paid option. Google's image API had no free tier as of early 2026; do not assume one. |
| `mock` | Free | Generates a deterministic placeholder PNG (prompt text and seed drawn on a colored background) with no network | Used in tests and CI, and for demoing without a GPU or keys. |

The interface:

```typescript
interface ImageProvider {
  name: string;
  isPaid: boolean;
  estimateCostUsd(req: GenerateRequest): number;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  generate(req: GenerateRequest, signal: AbortSignal): Promise<GenerateResult>; // returns PNG bytes + model + seed
}
```

## Routing, fallback and spend cap

The router's one hard rule: it never moves from a free provider to a paid one unless the user has explicitly allowed it.

For each `generate_image` call, the router:

1. Uses the `provider` argument if given; otherwise the first entry in `DARKROOM_PROVIDER_ORDER` (default `comfyui`).
2. Runs the provider's health check (cached for 60s) and skips unhealthy ones.
3. Before any paid call, checks the estimate against the remaining daily budget and refuses with a clear error if it would exceed `DARKROOM_DAILY_CAP_USD` (default $2.00).
4. On failure or timeout, tries the next provider in order, but skips paid providers unless `DARKROOM_ALLOW_PAID_FALLBACK=true`.
5. Reports in the result which provider actually served the request and why any were skipped, so a fallback is never silent.

Spend is tracked in a small JSON ledger in the output directory, keyed by UTC date. The `mock` provider never counts toward spend and is never chosen as a fallback for a real request unless it is explicitly listed in the order.

## Configuration and security

All configuration comes from environment variables, validated with zod at startup; the server fails fast with a readable message if anything is invalid.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DARKROOM_OUTPUT_DIR` | Yes | none | Absolute path for images, sidecars, and the spend ledger. Relative paths are rejected, because the server's working directory depends on the client. |
| `DARKROOM_PROVIDER_ORDER` | No | `comfyui` | Comma-separated priority list |
| `DARKROOM_DAILY_CAP_USD` | No | `2.00` | Daily paid-spend ceiling |
| `DARKROOM_ALLOW_PAID_FALLBACK` | No | `false` | Lets the router fall from free to paid providers |
| `COMFYUI_URL` | No | `http://127.0.0.1:8188` | Local ComfyUI server |
| `COMFYUI_WORKFLOW` | No | `flux` | Which template in `workflows/` to use |
| `OPENAI_API_KEY`, `GEMINI_API_KEY` | No | none | A paid provider is enabled only when its key is present |

Security requirements:

- Never log or return API keys; redact them from error messages.
- Sanitize `filename` to a safe slug and resolve every write inside `DARKROOM_OUTPUT_DIR`; reject path traversal.
- Cap prompt length (4,000 characters) and image dimensions (max 2048px per side).
- Log to stderr only, since stdout is the MCP stdio channel.
- README documents keeping keys out of `~/.claude.json`, for example by launching Claude Code through a secret manager.

## Testing and eval

The full test suite must pass in CI with no GPU, no network, and no API keys; that is what the `mock` provider is for.

**Tests (vitest)**

- Unit: router order, health-check skipping, paid-fallback gating, spend cap math and ledger rollover at UTC midnight, filename sanitizing and path traversal rejection, config validation.
- Provider contract: one shared test suite every provider must pass, run against `mock` always and against real providers only when an env flag and key are set.
- Recorded fixtures: capture one real response per paid provider and the ComfyUI `/prompt` → `/history` → `/view` sequence, so parsing is tested offline.
- Integration: spawn the server over stdio with the MCP SDK client, call all three tools, and assert on the returned content blocks.
- Manual smoke test with the MCP Inspector, documented in the README.

**Eval (`npm run eval`)**

A fixed set of 10 prompts covering text rendering, people, objects, a UI icon, and a scene, run against every enabled provider. It writes `eval/report.md` with a thumbnail grid plus latency and cost per provider. No automatic quality scoring in v1: the grid is for a human to judge, and the report doubles as the README's comparison section.

## Milestones and acceptance criteria

Five milestones, each ending in a commit Matt can review; the agent stops after each one for a check-in rather than running ahead.

1. **M0: Scaffold and mock.** Repo, TypeScript strict, lint, vitest, CI, config validation, and the `mock` provider behind `generate_image`.
   - Done when: `claude mcp add` registers the server and Claude Code returns a placeholder image it can see.
2. **M1: Local generation.** The `comfyui` provider with Flux and SDXL workflow templates, timeouts, and health checks.
   - Done when: a real Flux image is generated from Claude Code at zero cost, saved with its sidecar.
3. **M2: Paid providers.** `openai` and `gemini`, plus cost estimates and the provider contract suite.
   - Done when: the same prompt runs on all four providers by changing only `provider`.
4. **M3: Router and guardrails.** Provider order, fallback, paid-fallback gating, the spend ledger and daily cap, `list_providers` and `list_images`.
   - Done when: with ComfyUI stopped, requests fail clearly by default and fall back to a paid provider only with the flag set; a request over the cap is refused.
5. **M4: Ship it.** Eval run and report, README (setup for each provider, config table, architecture diagram, demo GIF of Claude generating, critiquing, and regenerating), npm publish.
   - Done when: a fresh machine can install it with one `claude mcp add ... npx` command and generate a mock image in under five minutes.

## Phase 2 stretch goals

None of these start until v1 is published; pick one at a time.

- **Accessibility metadata.** A `save_alt_text` tool so Claude, which can already see the image, writes alt text into the sidecar; plus a contrast check of the image's dominant colors against supplied text colors (WCAG 2.2 AA ratios).
- **Image-to-image and editing.** An optional `reference_image` input on providers that support it.
- **Remote deployment on AWS.** Streamable HTTP transport, Lambda or ECS behind API Gateway, Cognito OAuth, and S3 for images, with local ComfyUI dropped or reached over a tunnel.
- **Prompt presets.** Named styles (icon, hero image, diagram-style illustration) that expand into tuned prompts per provider.

## Instructions for the coding agent

Build milestone by milestone and stop for review after each; do not start Phase 2.

- Before writing provider code, check current docs for the MCP TypeScript SDK, the OpenAI Images API, the Gemini image API, and the ComfyUI HTTP API. Model names, parameters, and prices change; update this spec's config defaults if they have.
- Stack: Node 20+, TypeScript strict, `@modelcontextprotocol/sdk`, zod, vitest, sharp (for previews and the mock PNG). Ask before adding any other runtime dependency.
- Keep providers isolated: no provider-specific logic in the router or tools.
- Small commits with clear messages, one milestone per PR or tagged commit, so the history tells the story in an interview.
- When a spec decision turns out wrong, propose the change in a short note rather than silently diverging.
- Write the README as you go, not at the end.

Suggested repo layout:

```text
darkroom-mcp/
  src/
    index.ts          # MCP server, stdio transport, tool registration
    config.ts         # env parsing and validation (zod)
    router.ts         # provider order, health, fallback, cap checks
    ledger.ts         # daily spend tracking
    storage.ts        # safe paths, PNG + JSON sidecar writes, previews
    tools/            # generate-image.ts, list-providers.ts, list-images.ts
    providers/        # types.ts, comfyui.ts, openai.ts, gemini.ts, mock.ts
  workflows/          # flux.json, sdxl.json (ComfyUI API-format templates)
  test/               # unit, contract, integration, fixtures/
  eval/               # prompts.json, run.ts, report.md
  README.md
```
