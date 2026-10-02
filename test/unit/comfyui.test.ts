import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createComfyUIProvider, type SocketLike } from "../../src/providers/comfyui.js";
import { loadWorkflow } from "../../src/providers/comfyui-workflow.js";
import type { GenerateRequest, ProgressUpdate } from "../../src/providers/types.js";

// Offline tests against responses recorded from a real ComfyUI (test/fixtures/comfyui).

const URL_ = "http://127.0.0.1:8188";
const workflow = await loadWorkflow("zimage");
const request: GenerateRequest = { prompt: "a ceramic mug that says DARKROOM", aspectRatio: "1:1", quality: "draft" };

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/comfyui/${name}`, import.meta.url), "utf8"));
const viewPng = readFileSync(new URL("../fixtures/comfyui/view.png", import.meta.url));

/** Swaps the recorded prompt id for the one the provider chose. */
function rekey<T>(value: T, recordedId: string, id: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll(recordedId, id)) as T;
}
const firstKey = (o: unknown) => Object.keys(o as object)[0] ?? "";

interface FakeOptions {
  history?: "history-success.json" | "history-error.json" | "history-interrupted.json" | null; // null: never finishes
  pollsBeforeDone?: number;
  rejectPrompt?: boolean;
  running?: boolean; // whether our job shows as running in /queue during cancel
  unreachable?: boolean | "bad port";
  missingClasses?: string[];
  missingModels?: string[];
}

function fakeComfy(o: FakeOptions = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let promptId = "";
  let polls = 0;
  const sockets: FakeSocket[] = [];

  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    if (init?.signal?.aborted) return Promise.reject(init.signal.reason as Error);
    if (o.unreachable) {
      // Same shapes as Node's fetch: refused connections carry a code; blocked ports only a message.
      const cause =
        o.unreachable === "bad port"
          ? new Error("bad port")
          : Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8188"), { code: "ECONNREFUSED" });
      return Promise.reject(new TypeError("fetch failed", { cause }));
    }

    const path = url.pathname;
    if (method === "POST" && path === "/prompt") {
      if (o.rejectPrompt) return json(fixture("prompt-400.json"), 400);
      promptId = (body as { prompt_id: string }).prompt_id;
      const recorded = fixture("ws-messages.json");
      setTimeout(() => {
        for (const msg of rekey(recorded, "e2d25b5f-9e90-422f-a628-6ef2c8dd3d15", promptId) as unknown[]) {
          for (const s of sockets) s.emit(JSON.stringify(msg));
        }
        for (const s of sockets) s.emit(JSON.stringify({ type: "progress", data: { value: 1, max: 99, prompt_id: "someone-else" } }));
      }, 0);
      return json({ prompt_id: promptId, number: 1, node_errors: {} });
    }
    if (path.startsWith("/history/")) {
      polls++;
      const name = o.history === undefined ? "history-success.json" : o.history;
      if (name === null || polls <= (o.pollsBeforeDone ?? 2)) return json({});
      const entry = fixture(name);
      return json(rekey(entry, firstKey(entry), promptId));
    }
    if (path === "/view") return Promise.resolve(new Response(viewPng));
    if (method === "GET" && path === "/queue") {
      const item = [1, promptId, {}, {}, ["output"]];
      return json({ queue_running: o.running ? [item] : [], queue_pending: [] });
    }
    if (method === "POST" && (path === "/queue" || path === "/interrupt")) return Promise.resolve(new Response(""));
    if (path === "/system_stats") return json(fixture("system_stats.json"));
    if (path.startsWith("/object_info/")) {
      const cls = decodeURIComponent(path.slice("/object_info/".length));
      if (o.missingClasses?.includes(cls)) return json({});
      let info: Record<string, { input: { required: Record<string, unknown> } }>;
      try {
        info = fixture(`object_info-${cls}.json`) as typeof info;
      } catch {
        info = { [cls]: { input: { required: {} } } };
      }
      for (const name of o.missingModels ?? []) {
        for (const spec of Object.values(info[cls]?.input.required ?? {})) {
          if (Array.isArray(spec) && Array.isArray(spec[0])) spec[0] = (spec[0] as string[]).filter((f) => f !== name);
        }
      }
      return json(info);
    }
    return json({ error: "not found" }, 404);
  };

  return {
    calls,
    sockets,
    posted: (path: string) => calls.filter((c) => c.method === "POST" && c.path === path).map((c) => c.body),
    provider: (over: { timeoutMs?: number; openSocket?: (url: string) => SocketLike } = {}) =>
      createComfyUIProvider({
        url: URL_,
        timeoutMs: over.timeoutMs ?? 10_000,
        workflow,
        fetch: fetchFn,
        pollIntervalMs: 1,
        openSocket:
          over.openSocket ??
          ((u) => {
            const s = new FakeSocket(u);
            sockets.push(s);
            return s;
          }),
      }),
  };
}

class FakeSocket implements SocketLike {
  closed = false;
  private listeners: ((e: { data: unknown }) => void)[] = [];
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (e: { data: unknown }) => void): void {
    if (type === "message") this.listeners.push(listener);
  }
  emit(data: unknown): void {
    if (!this.closed) for (const l of this.listeners) l({ data });
  }
  close(): void {
    this.closed = true;
  }
}

const signal = () => new AbortController().signal;

describe("comfyui provider: generate", () => {
  it("submits the filled-in template, polls history, and returns the image from /view", async () => {
    const comfy = fakeComfy();
    const result = await comfy.provider().generate({ ...request, seed: 42 }, signal());

    const [submitted] = comfy.posted("/prompt") as { prompt: Record<string, { inputs: Record<string, unknown> }>; client_id: string; prompt_id: string }[];
    expect(submitted?.prompt.pos?.inputs.text).toBe(request.prompt);
    expect(submitted?.prompt.sample?.inputs.seed).toBe(42);
    expect([submitted?.prompt.latent?.inputs.width, submitted?.prompt.latent?.inputs.height]).toEqual([512, 512]);
    expect(submitted?.client_id).toMatch(/^[0-9a-f-]{36}$/);

    expect(comfy.calls.filter((c) => c.path.startsWith("/history/")).length).toBe(3);
    const view = comfy.calls.find((c) => c.path.startsWith("/view"));
    expect(view?.path).toBe("/view?filename=ComfyUI_temp_ltpqi_00001_.png&subfolder=&type=temp");

    // The size comes from the returned PNG, not from what was requested.
    expect(result).toMatchObject({ model: "z-image-turbo-q4_k_m", width: 8, height: 8, seed: 42, actualCostUsd: 0 });
    expect((await sharp(result.png).metadata()).format).toBe("png");
    expect(comfy.posted("/interrupt")).toEqual([]);
  });

  it("sizes final 16:9 at about one megapixel", async () => {
    const comfy = fakeComfy();
    await comfy.provider().generate({ ...request, aspectRatio: "16:9", quality: "final" }, signal());
    const [submitted] = comfy.posted("/prompt") as { prompt: Record<string, { inputs: Record<string, unknown> }> }[];
    expect([submitted?.prompt.latent?.inputs.width, submitted?.prompt.latent?.inputs.height]).toEqual([1360, 768]);
  });

  it("picks a random seed when none is given and reports it", async () => {
    const result = await fakeComfy().provider().generate(request, signal());
    expect(result.seed).toEqual(expect.any(Number));
    expect(result.seed).toBeGreaterThanOrEqual(0);
  });

  it("is free and doesn't support negative prompts with the Z-Image template", () => {
    const p = fakeComfy().provider();
    expect(p.isPaid).toBe(false);
    expect(p.estimateCostUsd(request)).toBe(0);
    expect(p.supports).toEqual({ negativePrompt: false, seed: true });
  });

  it("explains a rejected workflow using ComfyUI's node errors", async () => {
    const comfy = fakeComfy({ rejectPrompt: true });
    await expect(comfy.provider().generate(request, signal())).rejects.toThrow(
      /ComfyUI rejected the workflow: Prompt outputs failed validation\. unet \(UnetLoaderGGUF\): unet_name: 'missing\.gguf' not in/,
    );
  });

  it("reports an execution error with the node and a memory hint", async () => {
    const comfy = fakeComfy({ history: "history-error.json" });
    await expect(comfy.provider().generate(request, signal())).rejects.toThrow(
      /ComfyUI failed in node sample \(KSampler\): MPS backend out of memory.*Close other apps/,
    );
    expect(comfy.posted("/interrupt")).toEqual([]); // the job already ended
  });

  it("reports a job interrupted inside ComfyUI", async () => {
    await expect(fakeComfy({ history: "history-interrupted.json" }).provider().generate(request, signal())).rejects.toThrow(
      /ComfyUI interrupted the job/,
    );
  });

  it("says when ComfyUI isn't reachable", async () => {
    await expect(fakeComfy({ unreachable: true }).provider().generate(request, signal())).rejects.toThrow(
      "Can't reach ComfyUI at http://127.0.0.1:8188 (ECONNREFUSED). Is it running?",
    );
  });
});

describe("comfyui provider: cancellation and timeout", () => {
  it("on abort, dequeues the job and interrupts it only because it is ours and running", async () => {
    const comfy = fakeComfy({ history: null, running: true });
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort(new Error("client cancelled"));
    }, 20);
    await expect(comfy.provider().generate(request, ac.signal)).rejects.toThrow(
      "Generation was cancelled, and the ComfyUI job was stopped.",
    );

    const id = (comfy.posted("/prompt")[0] as { prompt_id: string }).prompt_id;
    expect(comfy.posted("/queue")).toEqual([{ delete: [id] }]);
    expect(comfy.posted("/interrupt")).toEqual([{ prompt_id: id }]);
  });

  it("does not interrupt when our job isn't the one running (it might be someone else's)", async () => {
    const comfy = fakeComfy({ history: null, running: false });
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort();
    }, 20);
    await expect(comfy.provider().generate(request, ac.signal)).rejects.toThrow();
    expect(comfy.posted("/queue")).toHaveLength(1);
    expect(comfy.posted("/interrupt")).toEqual([]);
  });

  it("times out with a clear message and cancels the job", async () => {
    const comfy = fakeComfy({ history: null, running: true });
    await expect(comfy.provider({ timeoutMs: 30 }).generate(request, signal())).rejects.toThrow(
      /ComfyUI didn't finish within 0s \(COMFYUI_TIMEOUT_MS, which includes time waiting in ComfyUI's queue\)\. The job was cancelled\./,
    );
    expect(comfy.posted("/interrupt")).toHaveLength(1);
  });
});

describe("comfyui provider: progress", () => {
  it("reports node and sampler steps for our job only, then closes the socket", async () => {
    const comfy = fakeComfy({ pollsBeforeDone: 5 });
    const updates: ProgressUpdate[] = [];
    await comfy.provider().generate(request, signal(), (u) => updates.push(u));

    const [socket] = comfy.sockets;
    expect(socket?.url).toMatch(/^ws:\/\/127\.0\.0\.1:8188\/ws\?clientId=[0-9a-f-]{36}$/);
    expect(socket?.closed).toBe(true);

    const messages = updates.map((u) => u.message);
    expect(messages[0]).toBe("Queued in ComfyUI");
    expect(messages).toContain("Started in ComfyUI");
    expect(messages).toContain("Running Load Z-Image Turbo (GGUF)");
    const steps = updates.filter((u) => u.step !== undefined);
    expect(steps.map((u) => u.message)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Sampling step ${n}/8`));
    expect(steps.at(-1)).toMatchObject({ step: 8, totalSteps: 8 });
  });

  it("doesn't open a socket when nobody listens for progress", async () => {
    const comfy = fakeComfy();
    await comfy.provider().generate(request, signal());
    expect(comfy.sockets).toEqual([]);
  });

  it("still generates when the websocket can't be opened", async () => {
    const comfy = fakeComfy();
    const p = comfy.provider({
      openSocket: () => {
        throw new Error("no websocket");
      },
    });
    const updates: ProgressUpdate[] = [];
    await expect(p.generate(request, signal(), (u) => updates.push(u))).resolves.toMatchObject({ width: 8 });
    expect(updates.map((u) => u.message)).toEqual(["Queued in ComfyUI"]);
  });
});

describe("comfyui provider: health check", () => {
  it("is healthy when every node and model file is present", async () => {
    expect(await fakeComfy().provider().healthCheck()).toEqual({ ok: true });
  });

  it("names the missing GGUF plugin and where to get it", async () => {
    const health = await fakeComfy({ missingClasses: ["UnetLoaderGGUF", "CLIPLoaderGGUF"] }).provider().healthCheck();
    expect(health).toEqual({
      ok: false,
      detail:
        "ComfyUI is missing the UnetLoaderGGUF, CLIPLoaderGGUF nodes: install the ComfyUI-GGUF custom node (https://github.com/city96/ComfyUI-GGUF) into ComfyUI's custom_nodes folder and restart ComfyUI.",
    });
  });

  it("tells you to update ComfyUI for a missing built-in node", async () => {
    const health = await fakeComfy({ missingClasses: ["ModelSamplingAuraFlow"] }).provider().healthCheck();
    expect(health.detail).toBe(
      'ComfyUI is missing the ModelSamplingAuraFlow node that the "zimage" workflow needs: update ComfyUI.',
    );
  });

  it("names a missing model file, its folder, and its download source", async () => {
    const health = await fakeComfy({ missingModels: ["z_image_turbo-Q4_K_M.gguf"] }).provider().healthCheck();
    expect(health).toEqual({
      ok: false,
      detail:
        "Model file z_image_turbo-Q4_K_M.gguf isn't in ComfyUI's models/unet folder: download it from https://huggingface.co/jayn7/Z-Image-Turbo-GGUF.",
    });
  });

  it("explains fetch failures that have no error code", async () => {
    const health = await fakeComfy({ unreachable: "bad port" }).provider().healthCheck();
    expect(health.detail).toMatch(/^Can't reach ComfyUI at http:\/\/127\.0\.0\.1:8188 \(bad port\)/);
  });

  it("says when ComfyUI isn't running", async () => {
    const health = await fakeComfy({ unreachable: true }).provider().healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/^Can't reach ComfyUI at http:\/\/127\.0\.0\.1:8188 \(ECONNREFUSED\)/);
  });
});
