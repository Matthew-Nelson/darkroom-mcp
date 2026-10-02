# Darkroom MCP

An MCP server that gives Claude Code an image generation tool. Claude writes the prompt, calls `generate_image`, sees the result, and iterates. Darkroom handles the provider, saves a PNG with a JSON metadata sidecar, and returns a preview Claude can look at.

Providers are swappable: a free local model (Z-Image Turbo via ComfyUI) by default, OpenAI or Gemini as opt-in paid options, and a `mock` provider for tests and demos.

> **Status:** early development (milestone M1). The `mock` and local `comfyui` providers work; the first paid provider lands in M2. See [`SPEC.md`](SPEC.md) for the plan.

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

## Tools

### `generate_image`

| Input | Default | Notes |
| --- | --- | --- |
| `prompt` | required | Up to 4,000 characters |
| `negative_prompt` | none | Ignored by providers that don't support it; reported in `ignored_params` |
| `aspect_ratio` | `1:1` | `1:1`, `3:2`, `2:3`, `16:9`, `9:16`. The result reports the actual pixel size |
| `quality` | `draft` | `draft` is about 0.25 megapixels (512×512 square, 688×384 at 16:9), `final` about 1 megapixel (1024×1024, 1360×768) |
| `provider` | configured order | Only for when the user asks for a specific provider |
| `seed` | random | Reuse a draft's seed to render it as `final` |
| `filename` | from the prompt | Sanitized to a slug; a unique suffix is always added |

Returns a JPEG preview (at most 768px on the long edge) for Claude to see, a text summary, and structured content: the absolute file path, sidecar path, provider, model, actual size, seed, latency, cost in USD, ignored parameters, and any providers that were skipped and why.

Each image is saved as `<slug>-<id>.png` next to `<slug>-<id>.json`, which holds the full request and the result metadata. Files are never overwritten.

## Configuration

All configuration comes from environment variables, validated at startup. The server exits with a readable message if anything is invalid.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DARKROOM_OUTPUT_DIR` | `~/.darkroom/images` | Absolute path for images and sidecars. Relative paths are rejected because the server's working directory depends on the client. A leading `~/` is expanded. |
| `DARKROOM_PROVIDER_ORDER` | `comfyui` | Comma-separated priority list: `mock`, `comfyui`, `openai`, `gemini` |
| `DARKROOM_DAILY_CAP_USD` | `2.00` | Daily paid-spend ceiling (enforced from M2) |
| `DARKROOM_ALLOW_PAID_FALLBACK` | `false` | Lets the router fall from free to paid providers already in the order (from M3) |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | Local ComfyUI server |
| `COMFYUI_WORKFLOW` | `zimage` | Workflow template in `workflows/`. A missing template fails startup |
| `COMFYUI_TIMEOUT_MS` | `300000` | Per-request timeout, including time waiting in ComfyUI's queue |
| `DARKROOM_OPENAI_API_KEY`, `DARKROOM_GEMINI_API_KEY` | none | Darkroom-specific keys (from M2). A generic `OPENAI_API_KEY` in your shell is ignored. |

## Development

```sh
npm run check   # typecheck + lint + tests (mock only: no GPU, network, or keys)
npm run build   # compile to dist/
npm run test:comfyui   # real ComfyUI at http://127.0.0.1:8188 (or COMFYUI_URL): one draft render plus a cancel; takes ~2 minutes
```

ComfyUI parsing is tested offline against responses recorded from a real server (`test/fixtures/comfyui/`).

The integration tests build `dist/` and drive the real server over stdio with the MCP SDK client.

Logs go to stderr, because stdout is the MCP protocol channel.
