# Progress

## Current: M0 — Scaffold and mock · status: not started

| Milestone | Status | Tag |
| --- | --- | --- |
| Spec review and stress test | done | — |
| Spike: local models on ComfyUI | done | — |
| M0: Scaffold and mock | not started | — |
| M1: Local generation (Z-Image) | not started | — |
| M2: Ledger + first paid provider | not started | — |
| M3: Router and guardrails | not started | — |
| M4: Ship it | not started | — |

Status values: `not started` → `in progress` → `awaiting review` → `done` (only once tagged).

## M0 gates

- [ ] `npm run check` passes
- [ ] Done when: `claude mcp add` registers the server with `DARKROOM_PROVIDER_ORDER=mock` and Claude Code returns a placeholder image it can see
- [ ] Preview payload size measured against Claude Code's MCP output limit
- [ ] Matt approved
- [ ] Tagged `m0`

## Next up

- Plan M0 (a few bullets) and confirm with Matt before coding.
- Decide the first paid provider (OpenAI vs. Gemini) before M2.

## Deviations from spec

None yet.

## Open questions

- Which paid provider ships in v1: OpenAI (better text in images) or Gemini (cheaper)? Needed by M2.
- Does Claude Code reset its MCP tool timeout on progress notifications? Verify in M1.

## Log

### Oct 2, 2026 — spec review and local model spike

- Stress-tested the spec and revised it: closed paid-spend loopholes, moved the ledger/cap before the first paid call, swapped `width`/`height` for `aspect_ratio`, cut v1 to mock + comfyui + one paid provider.
- Installed ComfyUI at `~/ComfyUI` and timed SDXL, Flux schnell, and Z-Image Turbo on the M3/16GB. Chose **Z-Image Turbo** as the default local model (best text rendering). Results, model sources, and findings are in `SPEC.md` under "Local model spike results".
- Spec changes from the spike: `quality: draft | final`, 300s ComfyUI timeout, required progress notifications, template mapping files listing model files, seed-variety guidance for Z-Image.
- Set up `CLAUDE.md`, this file, and `scripts/bench-comfyui.py`.
