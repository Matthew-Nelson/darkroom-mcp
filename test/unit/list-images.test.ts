import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEDGER_FILENAME } from "../../src/ledger.js";
import { listImages } from "../../src/tools/list-images.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "darkroom-list-images-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

let n = 0;

/** Writes a PNG (unless `png: false`) and its sidecar the way Storage does, and returns the stem. */
async function saved(o: { at: string; provider?: string; prompt?: string; png?: boolean; sidecar?: unknown }) {
  const stem = `image-${(n++).toString(16).padStart(8, "0")}`;
  const sidecar = o.sidecar ?? {
    image: `${stem}.png`,
    version: 1,
    created_at: o.at,
    request: { prompt: o.prompt ?? "a mug", aspect_ratio: "3:2", quality: "draft" },
    provider: o.provider ?? "mock",
    model: `${o.provider ?? "mock"}-model`,
    width: 624,
    height: 416,
    seed: 42,
    latency_ms: 10,
    cost_usd: o.provider === "openai" ? 0.0037 : 0,
    cost_is_estimate: false,
    ignored_params: [],
    skipped_providers: [],
  };
  await writeFile(join(dir, `${stem}.json`), typeof sidecar === "string" ? sidecar : JSON.stringify(sidecar));
  if (o.png !== false) await writeFile(join(dir, `${stem}.png`), "png");
  return stem;
}

describe("listImages", () => {
  it("returns the newest images first, up to the limit, with their metadata", async () => {
    await saved({ at: "2026-10-02T10:00:00.000Z", prompt: "oldest" });
    const middle = await saved({ at: "2026-10-02T11:00:00.000Z", prompt: "middle", provider: "openai" });
    await saved({ at: "2026-10-02T12:00:00.000Z", prompt: "newest" });

    const out = await listImages(dir, { limit: 2 });
    expect(out.images.map((i) => i.prompt)).toEqual(["newest", "middle"]);
    expect(out.total).toBe(3);
    expect(out.unreadable).toBe(0);
    expect(out.images[1]).toEqual({
      path: join(dir, `${middle}.png`),
      sidecar_path: join(dir, `${middle}.json`),
      created_at: "2026-10-02T11:00:00.000Z",
      prompt: "middle",
      provider: "openai",
      model: "openai-model",
      quality: "draft",
      aspect_ratio: "3:2",
      width: 624,
      height: 416,
      seed: 42,
      cost_usd: 0.0037,
      alt_text: null,
    });
  });

  it("returns saved alt text, and drops a hand-edited one that isn't a string", async () => {
    const sidecar = (alt: unknown) => ({
      version: 1,
      created_at: "2026-10-02T10:00:00.000Z",
      request: { prompt: "a mug", aspect_ratio: "1:1", quality: "draft" },
      provider: "mock",
      model: "m",
      width: 1,
      height: 1,
      seed: null,
      cost_usd: 0,
      alt_text: alt,
    });
    await saved({ at: "", sidecar: sidecar("A white mug on a desk.") });
    await saved({ at: "", sidecar: sidecar(42) });
    const out = await listImages(dir, { limit: 20 });
    expect(out.images.map((i) => i.alt_text).sort()).toEqual(["A white mug on a desk.", null]);
    expect(out.unreadable).toBe(0);
  });

  it("filters by provider", async () => {
    await saved({ at: "2026-10-02T10:00:00.000Z", provider: "openai" });
    await saved({ at: "2026-10-02T11:00:00.000Z", provider: "mock" });
    const out = await listImages(dir, { limit: 20, provider: "openai" });
    expect(out.images.map((i) => i.provider)).toEqual(["openai"]);
    expect(out.total).toBe(1);
  });

  it("is empty for an empty folder", async () => {
    expect(await listImages(dir, { limit: 20 })).toEqual({ images: [], total: 0, unreadable: 0 });
  });

  it("ignores the spend ledger and its temp files", async () => {
    await writeFile(join(dir, LEDGER_FILENAME), "{}");
    await writeFile(join(dir, `${LEDGER_FILENAME}.0a1b2c3d.tmp`), "{}");
    await saved({ at: "2026-10-02T10:00:00.000Z" });
    expect(await listImages(dir, { limit: 20 })).toMatchObject({ total: 1, unreadable: 0 });
  });

  it("counts broken sidecars and sidecars whose PNG is gone as unreadable, and lists the rest", async () => {
    await saved({ at: "2026-10-02T10:00:00.000Z", sidecar: "{ not json" });
    await saved({ at: "2026-10-02T10:00:00.000Z", sidecar: { image: "x.png", version: 1 } });
    await saved({ at: "2026-10-02T11:00:00.000Z", png: false });
    await saved({ at: "2026-10-02T12:00:00.000Z", prompt: "fine" });
    const out = await listImages(dir, { limit: 20 });
    expect(out.images.map((i) => i.prompt)).toEqual(["fine"]);
    expect(out.unreadable).toBe(3);
  });

  it("logs unexpected read errors, but not a broken sidecar or a missing PNG", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await mkdir(join(dir, "folder-0123abcd.json")); // reading it fails with EISDIR
      await saved({ at: "2026-10-02T10:00:00.000Z", sidecar: "{ not json" });
      await saved({ at: "2026-10-02T11:00:00.000Z", png: false });
      expect(await listImages(dir, { limit: 20 })).toMatchObject({ total: 0, unreadable: 3 });
      const lines = stderr.mock.calls.map(([line]) => String(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[darkroom\] warn: couldn't read image sidecar .*folder-0123abcd\.json.*EISDIR/);
    } finally {
      stderr.mockRestore();
    }
  });

  it("takes the PNG path from the sidecar's own name, never from its contents", async () => {
    const stem = await saved({ at: "2026-10-02T10:00:00.000Z" });
    const sidecar = JSON.stringify({
      image: "../../etc/passwd",
      version: 1,
      created_at: "2026-10-02T10:00:00.000Z",
      request: { prompt: "a mug", aspect_ratio: "1:1", quality: "draft" },
      provider: "mock",
      model: "m",
      width: 1,
      height: 1,
      seed: null,
      cost_usd: 0,
    });
    await writeFile(join(dir, `${stem}.json`), sidecar);
    const [image] = (await listImages(dir, { limit: 20 })).images;
    expect(image?.path).toBe(join(dir, `${stem}.png`));
    expect(image?.seed).toBeNull();
  });
});
