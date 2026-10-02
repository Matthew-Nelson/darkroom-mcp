# Darkroom MCP

An MCP server that gives Claude Code an image generation tool. Claude writes the prompt, calls `generate_image`, sees the result, and iterates. Darkroom handles the provider, saves a PNG with a JSON metadata sidecar, and returns a preview Claude can look at.

Providers are swappable: a free local model (Z-Image Turbo via ComfyUI) by default, OpenAI or Gemini as opt-in paid options, and a `mock` provider for tests and demos.

> **Status:** early development (milestone M2). The `mock`, local `comfyui`, and paid `openai` providers work; fallback between providers and the `list_*` tools land in M3. See [`SPEC.md`](SPEC.md) for the plan.

## Quick start (mock provider)

Requires Node 22.12 or newer.

```sh
git clone https://github.com/Matthew-Nelson/darkroom-mcp.git
cd darkroom-mcp
npm install
npm run build

claude mcp add darkroom -e DARKROOM_PROVIDER_ORDER=mock -- node "$PWD/dist/index.js"
```

Start a new Claude Code session and ask for an image, for example "make me a placeholder hero image, 16:9". The mock provider draws the prompt and seed on a colored background, so you can try the whole flow without a GPU or API keys.

## Local generation (ComfyUI + Z-Image Turbo)

The default provider runs [Z-Image Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) on your own machine through [ComfyUI](https://github.com/Comfy-Org/ComfyUI): free, private, and slow. On a 16GB Apple M3, a `draft` takes about 1.5 minutes and a `final` about 3.5 minutes. **16GB of memory is the practical minimum**; generation peaks around 11–12GB, so close other heavy apps.

1. Install ComfyUI (a Python 3.12 venv works well; very new Python releases may not have PyTorch builds yet).
2. Install the [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) custom node into `ComfyUI/custom_nodes` (the full-size weights don't fit in 16GB; the GGUF builds do).
3. Download the model files into `ComfyUI/models/` (about 7.5GB in total, all ungated):

   | Folder | File | Source |
   | --- | --- | --- |
   | `unet/` | `z_image_turbo-Q4_K_M.gguf` | [jayn7/Z-Image-Turbo-GGUF](https://huggingface.co/jayn7/Z-Image-Turbo-GGUF) |
   | `clip/` | `Qwen3-4B-Q4_K_M.gguf` | [unsloth/Qwen3-4B-GGUF](https://huggingface.co/unsloth/Qwen3-4B-GGUF) |
   | `vae/` | `flux_ae.safetensors` | [Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo), `split_files/vae/ae.safetensors`, renamed |

4. Start ComfyUI (`python main.py --listen 127.0.0.1 --port 8188`) and register Darkroom:

   ```sh
   claude mcp add darkroom -- node "$PWD/dist/index.js"
   ```

   The default order is `comfyui`. Use `-e DARKROOM_PROVIDER_ORDER=comfyui,mock` if you'd rather get a placeholder than an error while ComfyUI is stopped.

Before each request Darkroom checks that ComfyUI is reachable and that every node and model file the workflow needs is installed. If something is missing, the error says what and where to get it, for example "ComfyUI is missing the UnetLoaderGGUF, CLIPLoaderGGUF nodes: install the ComfyUI-GGUF custom node (…) into ComfyUI's custom_nodes folder and restart ComfyUI."

**Seeds:** Z-Image Turbo barely varies by seed; a new seed gives nearly the same picture. To explore, reword the prompt. Reuse a draft's seed when rendering it as `final` to keep the composition.

**Timeouts and progress:** while ComfyUI works, Darkroom sends MCP progress notifications (sampler step, e.g. "Sampling step 3/8", plus a heartbeat every 5 seconds). Claude Code shows these for background tasks, and they reset its MCP idle timeout (30 minutes for stdio servers); its overall tool timeout defaults to about 28 hours, so local renders don't need any timeout changes. Darkroom's own limit is `COMFYUI_TIMEOUT_MS` (5 minutes, including time waiting in ComfyUI's queue). When a request times out or is cancelled, Darkroom removes its job from ComfyUI's queue, or interrupts it if it's running, so the GPU stops; it never interrupts another client's job.

**Templates:** `workflows/zimage.json` is an ordinary ComfyUI API-format graph, and `zimage.map.json` tells Darkroom which node inputs take the prompt, seed, and size, which node produces the image, and which model files and custom nodes the health check should look for. Images come back through ComfyUI's temp folder, so the only permanent copy is the one in `DARKROOM_OUTPUT_DIR`.

## Paid generation (OpenAI)

Darkroom never spends money unless you opt in twice: set **`DARKROOM_OPENAI_API_KEY`** *and* list `openai` in `DARKROOM_PROVIDER_ORDER`. A generic `OPENAI_API_KEY` in your shell is ignored on purpose, so a key you exported for something else never spends money here.

```sh
claude mcp add darkroom \
  -e DARKROOM_PROVIDER_ORDER=comfyui,openai \
  -- node "$PWD/dist/index.js"
```

Keep the key out of `~/.claude.json` (which `claude mcp add -e` would write it into). On macOS, store it in the Keychain and launch Claude Code with it in the environment:

```sh
security add-generic-password -a "$USER" -s darkroom-openai -w   # prompts for the key
DARKROOM_OPENAI_API_KEY=$(security find-generic-password -s darkroom-openai -w) claude
```

For the key itself, a restricted key (Images: Write only) in a dedicated OpenAI project with its own budget limits the damage if it ever leaks.

**Model and sizes.** The default model is `gpt-image-2.5-flare` (`DARKROOM_OPENAI_MODEL` picks another one Darkroom has rates for). OpenAI's smallest image is 655,360 pixels, so the tiers map like this:

| `quality` | OpenAI quality | Size (1:1 / 16:9) |
| --- | --- | --- |
| `draft` | `low` | 816×816 / 1088×608 (the smallest allowed) |
| `final` | `high` | 1024×1024 / 1360×768 (same as local) |

OpenAI has no seed control, and it doesn't take a negative prompt; both are reported in `ignored_params`.

**Spend cap.** Every paid request first reserves its estimated cost against `DARKROOM_DAILY_CAP_USD` (default $2.00) and is refused, before anything is sent, if that would go over. Afterwards the reservation becomes the actual cost OpenAI reports from token usage. A request that fails in a way OpenAI may still have billed (a timeout, a dropped connection, a server error) keeps its estimate; one rejected up front (a bad key, a blocked prompt) counts nothing.

- The day rolls over at **UTC midnight**, not local midnight.
- Spend is recorded in `spend-ledger.json` in `DARKROOM_OUTPUT_DIR`, so two setups with different output directories have separate caps. If the ledger is ever corrupt, paid providers are blocked until it's fixed or moved aside.
- Separate Claude Code sessions share the ledger file, but two sessions starting paid requests in the same instant can both pass the cap check. That small race is accepted.
- Results report `cost_usd`, with `cost_is_estimate: true` only when the provider didn't report usage.

**Fallback.** If a free provider earlier in the order is skipped (for example, ComfyUI isn't running), Darkroom does **not** move on to a paid one unless `DARKROOM_ALLOW_PAID_FALLBACK=true`. Asking for `provider: "openai"` explicitly still goes through the cap.

## Tools

### `generate_image`

| Input | Default | Notes |
| --- | --- | --- |
| `prompt` | required | Up to 4,000 characters |
| `negative_prompt` | none | Ignored by providers that don't support it; reported in `ignored_params` |
| `aspect_ratio` | `1:1` | `1:1`, `3:2`, `2:3`, `16:9`, `9:16`. The result reports the actual pixel size |
| `quality` | `draft` | Locally, `draft` is about 0.25 megapixels (512×512 square, 688×384 at 16:9) and `final` about 1 megapixel (1024×1024, 1360×768). OpenAI renders drafts larger; see above |
| `provider` | configured order | Only for when the user asks for a specific provider |
| `seed` | random | Reuse a draft's seed to render it as `final` |
| `filename` | from the prompt | Sanitized to a slug; a unique suffix is always added |

Returns a JPEG preview (at most 768px on the long edge) for Claude to see, a text summary, and structured content: the absolute file path, sidecar path, provider, model, actual size, seed, latency, cost in USD, ignored parameters, and any providers that were skipped and why.

Each image is saved as `<slug>-<id>.png` next to `<slug>-<id>.json`, which holds the full request and the result metadata. Files are never overwritten.

## Configuration

All configuration comes from environment variables, validated at startup. The server exits with a readable message if anything is invalid.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DARKROOM_OUTPUT_DIR` | `~/.darkroom/images` | Absolute path for images, sidecars, and the spend ledger. Relative paths are rejected because the server's working directory depends on the client. A leading `~/` is expanded. |
| `DARKROOM_PROVIDER_ORDER` | `comfyui` | Comma-separated priority list: `mock`, `comfyui`, `openai`, `gemini` |
| `DARKROOM_DAILY_CAP_USD` | `2.00` | Daily paid-spend ceiling, in USD, per UTC day |
| `DARKROOM_ALLOW_PAID_FALLBACK` | `false` | Lets the router move from a skipped free provider to a paid one already in the order |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | Local ComfyUI server |
| `COMFYUI_WORKFLOW` | `zimage` | Workflow template in `workflows/`. A missing template fails startup |
| `COMFYUI_TIMEOUT_MS` | `300000` | Per-request timeout, including time waiting in ComfyUI's queue. 1000 to 2147483647 (about 24.8 days, Node's timer limit) |
| `DARKROOM_OPENAI_API_KEY`, `DARKROOM_GEMINI_API_KEY` | none | Darkroom-specific keys. A paid provider needs its key **and** a place in the order. A generic `OPENAI_API_KEY` in your shell is ignored. (Gemini isn't built yet.) |
| `DARKROOM_OPENAI_MODEL` | `gpt-image-2.5-flare` | OpenAI image model. Must be one Darkroom has rates for (`gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2`); anything else fails startup |
| `DARKROOM_OPENAI_TIMEOUT_MS` | `180000` | Per-request OpenAI timeout, 1000 to 2147483647 |

## Development

```sh
npm run check   # typecheck + lint + tests (mock only: no GPU, network, or keys)
npm run build   # compile to dist/
npm run test:comfyui   # real ComfyUI at http://127.0.0.1:8188 (or COMFYUI_URL): one draft render plus a cancel; takes ~2 minutes
npm run test:contract  # provider contract suite; add DARKROOM_CONTRACT_COMFYUI=1 or DARKROOM_CONTRACT_OPENAI=1 to include real providers
```

Every provider passes the same contract suite (`test/contract/`): `mock` and `openai` (against a fake API) in every test run, and real ComfyUI or OpenAI only with the flags above. The real OpenAI run costs money, prints its estimated spend first, and bypasses the ledger.

ComfyUI parsing is tested offline against responses recorded from a real server (`test/fixtures/comfyui/`), and OpenAI parsing against fixtures in `test/fixtures/openai/`.

The integration tests build `dist/` and drive the real server over stdio with the MCP SDK client.

Logs go to stderr, because stdout is the MCP protocol channel.
