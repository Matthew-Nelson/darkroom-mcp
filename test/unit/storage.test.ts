import { mkdtemp, readdir, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertInside, makePreview, slugify, Storage, StorageError } from "../../src/storage.js";

describe("slugify", () => {
  it.each([
    ["Hero Image", "hero-image"],
    ["hero_image.png", "hero-image"],
    ["photo.JPEG", "photo"],
    ["Café Ünïcode", "cafe-unicode"],
    ["../../etc/passwd", "etc-passwd"],
    ["..\\..\\windows\\system32", "windows-system32"],
    ["/absolute/path/name", "absolute-path-name"],
    ["~/.ssh/authorized_keys", "ssh-authorized-keys"],
    ["name\u0000with-null", "name-with-null"],
    ["..", "image"],
    ["", "image"],
    ["🎨🖼️", "image"],
    ["---a---b---", "a-b"],
  ])("%j -> %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("caps length at a word boundary", () => {
    const slug = slugify("a cozy reading nook with a big window and rain outside on a grey afternoon in autumn");
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toBe("a-cozy-reading-nook-with-a-big-window-and-rain-outside-on-a");
  });

  it("hard-cuts a single long word", () => {
    expect(slugify("x".repeat(100))).toBe("x".repeat(60));
  });
});

describe("assertInside", () => {
  it("accepts a path inside the root", () => {
    expect(() => {
      assertInside("/out", "/out/a.png");
    }).not.toThrow();
  });

  it.each(["/out", "/out/../etc/passwd", "/other/a.png", "/outside/a.png"])("rejects %s", (candidate) => {
    expect(() => {
      assertInside("/out", candidate);
    }).toThrow(StorageError);
  });
});

describe("Storage", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "darkroom-storage-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const png = Buffer.from("not really a png");

  it("creates a missing output directory", async () => {
    const storage = await Storage.open(join(dir, "nested", "images"));
    const saved = await storage.save("x", png, {});
    expect(dirname(saved.pngPath)).toBe(storage.root);
  });

  it("recreates the output directory if it's deleted while the server runs", async () => {
    const storage = await Storage.open(join(dir, "images"));
    await rm(storage.root, { recursive: true });
    const saved = await storage.save("x", png, {});
    expect(await readFile(saved.pngPath)).toEqual(png);
  });

  it("writes the PNG and a JSON sidecar with a unique suffix", async () => {
    const storage = await Storage.open(dir);
    const saved = await storage.save("My Hero", png, { provider: "mock", seed: 7 });
    expect(saved.pngPath).toMatch(/\/my-hero-[0-9a-f]{8}\.png$/);
    expect(saved.sidecarPath).toBe(saved.pngPath.replace(/\.png$/, ".json"));
    expect(await readFile(saved.pngPath)).toEqual(png);
    const sidecar = JSON.parse(await readFile(saved.sidecarPath, "utf8")) as Record<string, unknown>;
    expect(sidecar).toEqual({ image: saved.pngPath.split("/").pop(), provider: "mock", seed: 7 });
  });

  it("never overwrites: the same name twice gives two files", async () => {
    const storage = await Storage.open(dir);
    const a = await storage.save("same", png, {});
    const b = await storage.save("same", png, {});
    expect(a.pngPath).not.toBe(b.pngPath);
    expect((await readdir(storage.root)).sort()).toHaveLength(4);
  });

  it("keeps a traversal filename inside the output directory", async () => {
    const storage = await Storage.open(dir);
    const saved = await storage.save("../../../tmp/evil", png, {});
    expect(dirname(saved.pngPath)).toBe(storage.root);
  });

  it("resolves a symlinked output directory to its real path", async () => {
    const real = join(dir, "real");
    const link = join(dir, "link");
    await Storage.open(real);
    await symlink(real, link);
    const storage = await Storage.open(link);
    const saved = await storage.save("x", png, {});
    expect(dirname(saved.pngPath)).toBe(storage.root);
    expect(storage.root).not.toContain("/link");
  });

  it("refuses to write if the output directory is swapped for a symlink after startup", async () => {
    const out = join(dir, "out");
    const elsewhere = join(dir, "elsewhere");
    const storage = await Storage.open(out);
    await Storage.open(elsewhere);
    await rename(out, join(dir, "moved"));
    await symlink(elsewhere, out);
    await expect(storage.save("x", png, {})).rejects.toThrow(StorageError);
    expect(await readdir(elsewhere)).toEqual([]);
  });
});

describe("makePreview", () => {
  const solid = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } })
      .png()
      .toBuffer();

  it("downscales to 768px on the long edge as JPEG", async () => {
    const preview = await makePreview(await solid(1824, 1024));
    const meta = await sharp(preview.jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([768, 431]);
    expect([preview.width, preview.height]).toEqual([768, 431]);
  });

  it("does not upscale small images", async () => {
    const meta = await sharp((await makePreview(await solid(512, 768))).jpeg).metadata();
    expect([meta.width, meta.height]).toEqual([512, 768]);
  });
});
