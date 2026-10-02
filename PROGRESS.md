# Progress

## Current: M1 — Local generation (Z-Image) · status: not started

| Milestone | Status | Tag |
| --- | --- | --- |
| Spec review and stress test | done | — |
| Spike: local models on ComfyUI | done | — |
| M0: Scaffold and mock | done | `m0` |
| M1: Local generation (Z-Image) | not started | — |
| M2: Ledger + first paid provider | not started | — |
| M3: Router and guardrails | not started | — |
| M4: Ship it | not started | — |

Status values: `not started` → `in progress` → `awaiting review` → `done` (only once tagged).

## M0 gates

- [x] `npm run check` passes (94 tests: 88 unit, 6 stdio integration)
- [x] Done when: `claude mcp add` registers the server with `DARKROOM_PROVIDER_ORDER=mock` and Claude Code returns a placeholder image it can see
- [x] Preview payload size measured against Claude Code's MCP output limit
- [x] Matt approved (saw a placeholder image in his own session)
- [x] Tagged `m0`

## Next up

- Plan M1 (ComfyUI provider with the Z-Image template) in a few bullets and confirm with Matt before coding.
- In M1, re-register `darkroom` without `DARKROOM_PROVIDER_ORDER=mock` (or with `comfyui,mock`) to test the real provider.
- Decide the first paid provider (OpenAI vs. Gemini) before M2.

## Deviations from spec

- **Tooling versions.** vitest 4.x, not 5.x (5.x needs Node 22, the spec says Node 20+). TypeScript 6.0, not 7.x (typescript-eslint doesn't support 7 yet). Runtime floor is Node 20.9 (sharp's minimum). Fresh `npm install` of vitest 4 trips an npm 10.9 resolver bug ("Cannot read properties of null (reading 'edgesOut')"); installs from the committed lockfile work.
- **Additions to `generate_image` output:** `sidecar_path`, and `cost_is_estimate` (true when the provider didn't report an actual cost), so "actual vs. estimate" isn't ambiguous.
- **`DARKROOM_OUTPUT_DIR` expands a leading `~/`.** Values in `~/.claude.json` aren't shell-expanded, and `~/...` is absolute in intent. Other relative paths are still rejected.
- **M0 router is a stub:** explicit provider, or the first implemented and healthy one in the order; no fallback on failure, no health caching. Provider names not built yet (comfyui until M1) are skipped with "not available in this version of Darkroom yet", so the default order gives a clear error rather than a startup crash. It also refuses every paid provider until the ledger lands in M2.

## Open questions

- Which paid provider ships in v1: OpenAI (better text in images) or Gemini (cheaper)? Needed by M2.
- Does Claude Code reset its MCP tool timeout on progress notifications? Verify in M1. (Docs research during M0 says stdio tools have a long wall-clock timeout plus an idle timeout that progress notifications reset; unverified.)
- License: `package.json` says `UNLICENSED` for now. Pick one before publishing in M4.

## Log

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
