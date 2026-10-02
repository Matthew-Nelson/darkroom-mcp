# Darkroom MCP

TypeScript MCP server that gives Claude Code an image generation tool across swappable providers (local ComfyUI by default, OpenAI/Gemini paid, mock for tests). `SPEC.md` is the source of truth for what to build.

## Start of every session

1. Read `PROGRESS.md` first. It says which milestone is current and its status.
2. Tell Matt in one line where things stand (e.g. "M1 is awaiting your review"), then continue from "Next up".
3. If `PROGRESS.md` and `git tag` disagree, the tags win: a milestone is only done once it's tagged.

## Working agreement

- Build one milestone at a time, in the order in `SPEC.md`. Don't start the next milestone or Phase 2 work without Matt's go-ahead.
- At the start of a milestone, give Matt a short plan (a few bullets) before writing code.
- Commit straight to `main` in small commits with clear messages. No feature branches.
- A milestone is done only when all three gates pass:
  1. **Automated:** `npm run check` (typecheck + lint + unit tests) passes. Required before every commit.
  2. **Acceptance:** the milestone's "done when" from `SPEC.md` was actually performed, with what was run and what happened recorded in `PROGRESS.md`.
  3. **Review:** Matt approved.
- After approval: update `PROGRESS.md` (and `SPEC.md`/README if anything changed), commit, tag `m0`, `m1`, …, push with `git push origin main --tags`, then stop so Matt can `/clear`.
- Push once per milestone (at tagging), not after every commit. Remote: `github.com/Matthew-Nelson/darkroom-mcp` (private).
- When the spec turns out wrong, propose the change in a short note and log it under "Deviations" in `PROGRESS.md`; don't silently diverge.
- Write a failing test that reproduces a bug before fixing it.
- Ask before adding any runtime dependency beyond the stack in `SPEC.md`.

## Testing rules

- `npm test` / `npm run check` must pass with no GPU, no network, and no API keys (mock provider only).
- Real ComfyUI tests run only on request (`npm run test:comfyui`), at `draft` quality. They take minutes.
- Paid-provider tests run only with an explicit env flag plus a key, and print the expected spend before running. Never run them unprompted.

## Local ComfyUI

- Installed at `~/ComfyUI` (ComfyUI 0.38.0, Python 3.12 venv in `.venv`, PyTorch 2.14.1 on MPS, ComfyUI-GGUF plugin). Don't use Homebrew's Python 3.14 for it.
- Start: `cd ~/ComfyUI && .venv/bin/python main.py --listen 127.0.0.1 --port 8188`
- Stop: `pkill -f "Python.*main.py --listen"` (it holds ~5GB of RAM while idle; stop it when not testing).
- Default model is Z-Image Turbo (GGUF). Model files and sources are listed in `SPEC.md` under "Local model spike results".
- `scripts/bench-comfyui.py` holds the reference Z-Image workflow graph and times a model end to end.
- Machine: M3, 16GB. Generation peaks around 11–12GB; a 1024px image takes ~3.5 min, a 512px draft ~1.5 min.

## Gotchas

- stdout is the MCP stdio channel: log to stderr only.
- Never log or return API keys.
