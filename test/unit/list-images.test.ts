import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
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
async function saved(o: {
  at: string;
  provider?: string;
  prompt?: string;
  png?: boolean;
  sidecar?: unknown;
  folder?: string;
}) {
  const at = o.folder === undefined ? dir : join(dir, o.folder);
  await mkdir(at, { recursive: true });
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
  await writeFile(join(at, `${stem}.json`), typeof sidecar === "string" ? sidecar : JSON.stringify(sidecar));
  if (o.png !== false) await writeFile(join(at, `${stem}.png`), "png");
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

  it("lists images from the top level and from session and date subfolders together", async () => {
    await saved({ at: "2026-10-02T10:00:00.000Z", prompt: "flat" });
    const session = await saved({ at: "2026-10-03T10:00:00.000Z", prompt: "session", folder: "2026-10-03_proj_a1a9e5c8" });
    await saved({ at: "2026-10-04T10:00:00.000Z", prompt: "dated", folder: "2026-10-04" });

    const out = await listImages(dir, { limit: 10 });
    expect(out.images.map((i) => i.prompt)).toEqual(["dated", "session", "flat"]);
    expect(out.images[1]?.path).toBe(join(dir, "2026-10-03_proj_a1a9e5c8", `${session}.png`));
  });

  it("skips folders save() doesn't name, deeper folders, and symlinked folders", async () => {
    await saved({ at: "2026-10-02T10:00:00.000Z", prompt: "other", folder: "thumbs" });
    await saved({ at: "2026-10-02T10:00:00.000Z", prompt: "deep", folder: join("2026-10-02", "2026-10-02") });
    const outside = await mkdtemp(join(tmpdir(), "darkroom-outside-"));
    try {
      await writeFile(join(outside, "evil-0123abcd.json"), "{}");
      await symlink(outside, join(dir, "2026-10-05"));
      expect(await listImages(dir, { limit: 10 })).toEqual({ images: [], total: 0, unreadable: 0 });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("is empty for an empty folder", async () => {
    expect(await listImages(dir, { limit: 20 })).toEqual({ images: [], total: 0, unreadable: 0 });
  });

  it("lists only names save() writes, so every listed path is one save_alt_text and check_contrast accept (review C4)", async () => {
    const stem = await saved({ at: "2026-10-02T10:00:00.000Z" });
    await rename(join(dir, `${stem}.json`), join(dir, "My_Photo-abcdef12.json"));
    await rename(join(dir, `${stem}.png`), join(dir, "My_Photo-abcdef12.png"));
    await saved({ at: "2026-10-02T11:00:00.000Z", prompt: "kept" });
    const out = await listImages(dir, { limit: 20 });
    expect(out.images.map((i) => i.prompt)).toEqual(["kept"]);
    expect(out).toMatchObject({ total: 1, unreadable: 0 });
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
