#!/usr/bin/env python3
"""Time a ComfyUI model through the same HTTP flow Darkroom's comfyui provider uses.

POST /prompt -> poll /history/{id} -> GET /view. Prints one JSON line with wall
time, ComfyUI's own execution time, and the server's peak memory footprint.
Stdlib only; macOS-specific for the memory reading (`footprint`).

Usage:
    python3 scripts/bench-comfyui.py zimage [prompt] [seed]
    SIZE=512 python3 scripts/bench-comfyui.py zimage

Env: SIZE (square px, default 1024), COMFYUI_URL (default http://127.0.0.1:8188),
BENCH_OUT (default ~/ComfyUI/output/darkroom_spike).

The zimage() graph is the reference for workflows/zimage.json in M1.
Results from the Oct 2, 2026 spike are recorded in SPEC.md. Its SDXL and Flux schnell
graphs were removed with those models (Oct 4, 2026); they're in git history.
"""
import json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
OUT = os.environ.get("BENCH_OUT", os.path.expanduser("~/ComfyUI/output/darkroom_spike"))
SIZE = int(os.environ.get("SIZE", 1024))
DEFAULT_PROMPT = 'A ceramic coffee mug on a wooden desk by a window, morning light, the mug reads "DARKROOM" in bold letters'


def zimage():
    return {
        "unet": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": "z_image_turbo-Q4_K_M.gguf"}},
        "shift": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["unet", 0], "shift": 3.0}},
        "clip": {"class_type": "CLIPLoaderGGUF", "inputs": {"clip_name": "Qwen3-4B-Q4_K_M.gguf", "type": "lumina2"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "flux_ae.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["clip", 0]}},
        "neg": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["pos", 0]}},
        "latent": {"class_type": "EmptySD3LatentImage", "inputs": {"width": SIZE, "height": SIZE, "batch_size": 1}},
        "sample": {"class_type": "KSampler", "inputs": {
            "model": ["shift", 0], "seed": 0, "denoise": 1.0,
            "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["latent", 0],
            "steps": 8, "cfg": 1.0, "sampler_name": "res_multistep", "scheduler": "simple"}},
        "decode": {"class_type": "VAEDecode", "inputs": {"samples": ["sample", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["decode", 0], "filename_prefix": "bench"}},
    }


WORKFLOWS = {"zimage": zimage}


def comfy_pid():
    out = subprocess.run(["pgrep", "-f", "Python.*main.py --listen"], capture_output=True, text=True).stdout.split()
    return out[0] if out else None


def footprint_peak_gb(pid):
    """Peak physical footprint (includes Metal/GPU allocations on Apple Silicon). Whole-GB precision above 1GB."""
    if not pid:
        return None
    out = subprocess.run(["footprint", pid], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if "phys_footprint_peak" in line:
            num, unit = line.split(":")[1].split()
            return round(float(num) / (1024 if unit == "MB" else 1), 2)
    return None


def http(method, path, body=None):
    req = urllib.request.Request(URL + path, method=method,
                                 data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} on {path}: {e.read().decode()[:2000]}")


def run(name, prompt, seed):
    g = WORKFLOWS[name]()
    g["pos"]["inputs"]["text"] = prompt
    g["sample"]["inputs"]["seed"] = seed
    g["save"]["inputs"]["filename_prefix"] = f"bench_{name}"
    pid = comfy_pid()

    t0 = time.time()
    prompt_id = json.loads(http("POST", "/prompt", {"prompt": g, "client_id": "darkroom-bench"}))["prompt_id"]
    while True:
        history = json.loads(http("GET", f"/history/{prompt_id}"))
        if prompt_id in history:
            break
        time.sleep(1)
    wall = time.time() - t0

    entry = history[prompt_id]
    status = entry.get("status", {})
    if status.get("status_str") != "success":
        errors = [m for m in status.get("messages", []) if m[0] == "execution_error"]
        sys.exit(f"{name}: FAILED {json.dumps(errors)[:2000]}")

    img = entry["outputs"]["save"]["images"][0]
    query = urllib.parse.urlencode({"filename": img["filename"], "subfolder": img["subfolder"], "type": img["type"]})
    data = http("GET", f"/view?{query}")
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{name}_{SIZE}_seed{seed}_{int(t0)}.png")
    with open(path, "wb") as f:
        f.write(data)

    ts = {m[0]: m[1].get("timestamp") for m in status.get("messages", [])}
    exec_s = (ts["execution_success"] - ts["execution_start"]) / 1000 if "execution_start" in ts and "execution_success" in ts else None
    print(json.dumps({"model": name, "size": SIZE, "seed": seed, "wall_s": round(wall, 1),
                      "exec_s": round(exec_s, 1) if exec_s else None,
                      "peak_footprint_gb": footprint_peak_gb(pid), "bytes": len(data), "path": path}))


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in WORKFLOWS:
        sys.exit(f"usage: bench-comfyui.py <{'|'.join(WORKFLOWS)}> [prompt] [seed]")
    run(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else DEFAULT_PROMPT,
        int(sys.argv[3]) if len(sys.argv) > 3 else 42)
