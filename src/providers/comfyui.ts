import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { log } from "../log.js";
import { buildGraph, nodeClasses, type Workflow } from "./comfyui-workflow.js";
import { sizeForQuality } from "./sizes.js";
import type { GenerateRequest, GenerateResult, ImageProvider, ProgressListener } from "./types.js";

// Talks to a local ComfyUI over HTTP: POST /prompt, poll /history/{id}, fetch the
// image from /view. Step-by-step progress comes from ComfyUI's websocket when it's
// available; generation works without it.

const HEALTH_TIMEOUT_MS = 5_000;
const CANCEL_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** The parts of the WebSocket API this provider uses, so tests can pass a fake. */
export interface SocketLike {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  close(): void;
}

export interface ComfyUIOptions {
  url: string;
  timeoutMs: number;
  workflow: Workflow;
  fetch?: typeof fetch;
  openSocket?: (url: string) => SocketLike;
  pollIntervalMs?: number;
  cancelTimeoutMs?: number;
}

/** What a cancel actually did, so the error message doesn't claim more than happened. */
type CancelOutcome =
  | { kind: "interrupted" } // our job was running; ComfyUI stops it at the next step
  | { kind: "dequeued" } // it hadn't started, and it's gone from the queue
  | { kind: "gone" } // not running or queued, but /history couldn't say whether it ever ran
  | { kind: "ended" } // it ended on its own just before the cancel: finished, failed, or stopped by someone else
  | { kind: "failed"; reason: string };

export class ComfyUIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComfyUIError";
  }
}

export function createComfyUIProvider(opts: ComfyUIOptions): ImageProvider {
  const { url, workflow } = opts;
  const { mapping } = workflow;
  const fetchFn = opts.fetch ?? fetch;
  const openSocket = opts.openSocket ?? ((u: string) => new WebSocket(u));
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const cancelTimeoutMs = opts.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;

  async function request(path: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    try {
      return await fetchFn(`${url}${path}`, {
        method: body === undefined ? "GET" : "POST",
        signal,
        ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ComfyUIError(
        `Can't reach ComfyUI at ${url} (${networkReason(err)}). Is it running? Set COMFYUI_URL if it isn't at that address.`,
      );
    }
  }

  async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
    const res = await request(path, signal);
    if (!res.ok) throw new ComfyUIError(`ComfyUI returned HTTP ${res.status} for GET ${path.split("?")[0] ?? path}.`);
    return res.json();
  }

  async function post(path: string, signal: AbortSignal, body: unknown): Promise<void> {
    const res = await request(path, signal, body);
    if (!res.ok) throw new ComfyUIError(`ComfyUI returned HTTP ${res.status} for POST ${path}.`);
  }

  async function submit(graph: unknown, promptId: string, clientId: string, signal: AbortSignal): Promise<string> {
    const res = await request("/prompt", signal, { prompt: graph, client_id: clientId, prompt_id: promptId });
    const body = (await res.json().catch(() => ({}))) as PromptResponse;
    if (!res.ok) throw new ComfyUIError(describeRejection(res.status, body));
    // ComfyUI before ~0.3.60 ignores a client-chosen prompt_id and mints its own.
    return typeof body.prompt_id === "string" ? body.prompt_id : promptId;
  }

  async function waitForHistory(promptId: string, signal: AbortSignal): Promise<HistoryEntry> {
    for (;;) {
      const entry = await historyEntry(promptId, signal);
      if (entry) return entry;
      await sleep(pollIntervalMs, undefined, { signal });
    }
  }

  async function fetchImage(entry: HistoryEntry, signal: AbortSignal): Promise<Buffer> {
    const image = entry.outputs?.[mapping.output.node]?.images?.[0];
    if (!image) throw new ComfyUIError(`ComfyUI finished, but output node "${mapping.output.node}" produced no image.`);
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
    const res = await request(`/view?${query.toString()}`, signal);
    if (!res.ok) throw new ComfyUIError(`ComfyUI returned HTTP ${res.status} when fetching the finished image.`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Stops our job so the GPU frees up: removes it from the queue if it's still
   * waiting, and interrupts it only if it's the one running. A bare /interrupt
   * would stop whatever is running, which might be someone else's job.
   *
   * Never throws: it reports what it actually did, checking /history to tell a
   * job it stopped from one that ended on its own first. It returns `failed`
   * (with the reason) if the delete, the /queue read, or the interrupt errors or
   * doesn't answer within cancelTimeoutMs. The /history checks are best effort:
   * once the job is stopped, a failed check only makes the message less specific.
   */
  async function cancel(promptId: string): Promise<CancelOutcome> {
    const signal = AbortSignal.timeout(cancelTimeoutMs);
    const isOurs = (item: unknown[]) => item[1] === promptId;
    try {
      // A submit cut off mid-request can still be queued after the first delete, so a pending job gets a second one.
      for (let attempt = 1; ; attempt++) {
        await post("/queue", signal, { delete: [promptId] });
        const queue = (await getJson("/queue", signal)) as QueueResponse;
        if (queue.queue_running?.some(isOurs)) {
          await post("/interrupt", signal, { prompt_id: promptId });
          log("info", "interrupted ComfyUI job", { prompt_id: promptId });
          // /interrupt does nothing if the job ended after the /queue read; then it's in /history without an interrupt.
          // Best effort: the interrupt went through, so a failed /history read leaves it at "interrupted".
          const entry = await historyEntry(promptId, signal).catch(() => undefined);
          const interrupted = !entry || entry.status?.messages?.some(([type]) => type === "execution_interrupted");
          return { kind: interrupted ? "interrupted" : "ended" };
        }
        if (!queue.queue_pending?.some(isOurs)) break;
        if (attempt === 2) throw new ComfyUIError("It's still in ComfyUI's queue after two deletes.");
      }
      // Not running and not queued: either the delete caught it waiting, or it ended before the cancel got there.
      // Best effort: the job is stopped either way, so a failed /history read only loses which one.
      const entry = await historyEntry(promptId, signal).catch(() => null);
      return { kind: entry === null ? "gone" : entry ? "ended" : "dequeued" };
    } catch (err) {
      const reason = signal.aborted
        ? `ComfyUI didn't answer the cancel within ${cancelTimeoutMs / 1000}s.`
        : errorMessage(err);
      log("warn", "couldn't cancel ComfyUI job", { prompt_id: promptId, error: reason });
      return { kind: "failed", reason };
    }
  }

  async function historyEntry(promptId: string, signal: AbortSignal): Promise<HistoryEntry | undefined> {
    return ((await getJson(`/history/${promptId}`, signal)) as Record<string, HistoryEntry>)[promptId];
  }

  function watchProgress(clientId: string, isOurs: (id: unknown) => boolean, onProgress: ProgressListener) {
    let socket: SocketLike;
    try {
      socket = openSocket(`${url.replace(/^http/, "ws")}/ws?clientId=${clientId}`);
    } catch {
      return undefined; // progress is best effort
    }
    socket.addEventListener("error", () => undefined);
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return; // binary messages are latent previews
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      // A throw here would crash the server (listener errors are uncaught), so drop anything that isn't an object.
      if (typeof parsed !== "object" || parsed === null) return;
      const msg = parsed as SocketMessage;
      const data = msg.data ?? {};
      if (!isOurs(data.prompt_id)) return;
      if (msg.type === "execution_start") {
        onProgress({ message: "Started in ComfyUI" });
      } else if (msg.type === "executing" && typeof data.node === "string") {
        const node = workflow.graph[data.node];
        const title = (node?._meta as { title?: string } | undefined)?.title ?? node?.class_type ?? data.node;
        onProgress({ message: `Running ${title}` });
      } else if (msg.type === "progress" && typeof data.value === "number" && typeof data.max === "number") {
        onProgress({ message: `Sampling step ${data.value}/${data.max}`, step: data.value, totalSteps: data.max });
      }
    });
    return socket;
  }

  return {
    name: "comfyui",
    model: mapping.model,
    isPaid: false,
    supports: { negativePrompt: mapping.inputs.negativePrompt !== undefined, seed: true, referenceImage: false },
    estimateCostUsd: () => 0,

    async healthCheck() {
      const signal = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
      try {
        await getJson("/system_stats", signal);
        const classes = nodeClasses(workflow);
        const infos = await Promise.all(
          classes.map(async (c) => [c, (await getJson(`/object_info/${encodeURIComponent(c)}`, signal)) as ObjectInfo] as const),
        );
        const info = new Map(infos.map(([c, body]) => [c, body[c]]));
        const problems = [
          ...missingNodeProblems(classes.filter((c) => !info.get(c))),
          ...missingModelProblems(info),
        ];
        return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join(" ") };
      } catch (err) {
        const detail = signal.aborted
          ? `ComfyUI at ${url} didn't answer within ${HEALTH_TIMEOUT_MS / 1000}s.`
          : errorMessage(err);
        return { ok: false, detail };
      }
    },

    async generate(req: GenerateRequest, signal: AbortSignal, onProgress?: ProgressListener): Promise<GenerateResult> {
      const seed = req.seed ?? randomInt(0, 2 ** 32);
      const { width, height } = sizeForQuality(req.aspectRatio, req.quality, mapping.sizeMultiple);
      const graph = buildGraph(workflow, { prompt: req.prompt, negativePrompt: req.negativePrompt, seed, width, height });

      const timeout = AbortSignal.timeout(opts.timeoutMs);
      const run = AbortSignal.any([signal, timeout]);
      const clientId = randomUUID();
      let promptId: string = randomUUID();
      let submitted = false;
      let finished = false;
      const socket = onProgress && watchProgress(clientId, (id) => id === promptId, onProgress);

      try {
        promptId = await submit(graph, promptId, clientId, run);
        submitted = true;
        onProgress?.({ message: "Queued in ComfyUI" });
        const entry = await waitForHistory(promptId, run);
        finished = true;
        throwIfFailed(entry);
        const raw = await fetchImage(entry, run);
        const png = await sharp(raw).png().toBuffer({ resolveWithObject: true });
        return {
          png: png.data,
          model: mapping.model,
          width: png.info.width,
          height: png.info.height,
          seed,
          actualCostUsd: 0, // local and free: the cost is known, not estimated
        };
      } catch (err) {
        socket?.close(); // no progress updates while the cancel runs
        // Read these before the cancel: either can flip while it runs, which would mislabel the error.
        const cancelled = signal.aborted;
        const timedOut = timeout.aborted && !cancelled;
        const seconds = Math.round(opts.timeoutMs / 1000);
        if (finished) {
          if (timedOut) {
            throw new ComfyUIError(
              `ComfyUI finished the job, but Darkroom couldn't fetch the image within ${seconds}s (COMFYUI_TIMEOUT_MS).`,
            );
          }
          if (cancelled) {
            throw new ComfyUIError("Generation was cancelled after ComfyUI finished the job, so the image wasn't saved.");
          }
          throw err;
        }
        // A submit that failed outright (rejected, or ComfyUI unreachable) queued nothing; one cut off by an abort may have.
        if (!submitted && !run.aborted) throw err;
        // The cancel runs before the message is written, so the message can say what it really did.
        const outcome = describeCancel(await cancel(promptId));
        if (timedOut) {
          throw new ComfyUIError(
            `ComfyUI didn't finish within ${seconds}s (COMFYUI_TIMEOUT_MS, which includes time waiting in ComfyUI's queue). ${outcome}`,
          );
        }
        if (cancelled) throw new ComfyUIError(`Generation was cancelled. ${outcome}`);
        throw new ComfyUIError(`${errorMessage(err)} ${outcome}`);
      } finally {
        socket?.close();
      }
    },
  };

  function missingNodeProblems(missing: string[]): string[] {
    const problems: string[] = [];
    let rest = missing;
    for (const pack of mapping.customNodes) {
      const fromPack = rest.filter((c) => pack.nodes.includes(c));
      if (fromPack.length === 0) continue;
      rest = rest.filter((c) => !fromPack.includes(c));
      problems.push(
        `ComfyUI is missing the ${fromPack.join(", ")} node${fromPack.length > 1 ? "s" : ""}: install the ${pack.name} custom node (${pack.source}) into ComfyUI's custom_nodes folder and restart ComfyUI.`,
      );
    }
    if (rest.length > 0) {
      problems.push(
        `ComfyUI is missing the ${rest.join(", ")} node${rest.length > 1 ? "s" : ""} that the "${workflow.name}" workflow needs: update ComfyUI.`,
      );
    }
    return problems;
  }

  function missingModelProblems(info: Map<string, NodeInfo | undefined>): string[] {
    return mapping.models.flatMap((model) => {
      const classType = workflow.graph[model.node]?.class_type ?? "";
      const node = info.get(classType);
      if (!node) return []; // already reported as a missing node
      const options = comboOptions(node.input?.required?.[model.input] ?? node.input?.optional?.[model.input]);
      if (options.includes(model.file)) return [];
      return [`Model file ${model.file} isn't in ComfyUI's models/${model.folder} folder: download it from ${model.source}.`];
    });
  }
}

function throwIfFailed(entry: HistoryEntry): void {
  const status = entry.status;
  if (!status || status.status_str !== "error") return;
  const messages = status.messages ?? [];
  const interrupted = messages.find(([type]) => type === "execution_interrupted");
  if (interrupted) {
    throw new ComfyUIError("ComfyUI interrupted the job (it was cancelled in ComfyUI or by another client).");
  }
  const failure = messages.find(([type]) => type === "execution_error")?.[1];
  if (failure) {
    const where = [failure.node_id, failure.node_type && `(${failure.node_type})`].filter(Boolean).join(" ");
    const reason = typeof failure.exception_message === "string" ? failure.exception_message.trim() : "unknown error";
    const hint = /out of memory/i.test(reason) ? " Close other apps to free memory, or use quality \"draft\"." : "";
    throw new ComfyUIError(`ComfyUI failed in node ${where}: ${reason}${hint}`);
  }
  throw new ComfyUIError("ComfyUI reported an error without details; check the ComfyUI console.");
}

function describeCancel(outcome: CancelOutcome): string {
  switch (outcome.kind) {
    case "interrupted":
      return "ComfyUI is stopping the job.";
    case "dequeued":
      return "The job hadn't started, and it's no longer in ComfyUI's queue.";
    case "gone":
      return "The job is no longer running or queued in ComfyUI.";
    case "ended":
      return "The ComfyUI job ended just as Darkroom went to cancel it, so there was nothing to stop.";
    case "failed":
      return `Darkroom couldn't cancel the ComfyUI job, so it may still be running. ${outcome.reason}`;
  }
}

function describeRejection(status: number, body: PromptResponse): string {
  const nodeErrors = Object.entries(body.node_errors ?? {}).flatMap(([id, n]) =>
    (n.errors ?? []).map((e) => `${id} (${n.class_type ?? "?"}): ${e.details || e.message || "invalid"}`),
  );
  const summary = body.error?.message ?? `HTTP ${status}`;
  const text = `ComfyUI rejected the workflow: ${summary}${nodeErrors.length ? `. ${nodeErrors.join("; ")}` : ""}`;
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

/** Combo inputs are either `[[...options], {...}]` or, in newer ComfyUI, `["COMBO", { options: [...] }]`. */
function comboOptions(spec: unknown): string[] {
  if (!Array.isArray(spec)) return [];
  const [first, second] = spec as unknown[];
  if (Array.isArray(first)) return first.filter((o): o is string => typeof o === "string");
  const options = (second as { options?: unknown } | undefined)?.options;
  return Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : [];
}

function networkReason(err: unknown): string {
  // Node's fetch throws "fetch failed" and puts the useful part (ECONNREFUSED, "bad port") in `cause`.
  const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  return cause?.code ?? (cause?.message || errorMessage(err));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface PromptResponse {
  prompt_id?: unknown;
  error?: { message?: string };
  node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }>;
}

interface HistoryEntry {
  outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>;
  status?: {
    status_str?: string;
    messages?: [string, { node_id?: string; node_type?: string; exception_message?: unknown }][];
  };
}

interface QueueResponse {
  queue_running?: unknown[][];
  queue_pending?: unknown[][];
}

interface NodeInfo {
  input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
}
type ObjectInfo = Record<string, NodeInfo | undefined>;

interface SocketMessage {
  type?: string;
  data?: { prompt_id?: unknown; node?: unknown; value?: unknown; max?: unknown };
}
