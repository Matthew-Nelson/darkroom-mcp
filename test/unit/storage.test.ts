import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

describe("Storage.find", () => {
  let dir: string;
  let storage: Storage;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "darkroom-find-"));
    storage = await Storage.open(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds an image by its absolute path or its filename", async () => {
    const saved = await storage.save("a mug", Buffer.from("png"), {});
    expect(await storage.find(saved.pngPath)).toEqual(saved);
    expect(await storage.find(basename(saved.pngPath))).toEqual(saved);
  });

  it("finds an image through a symlinked path to the output folder", async () => {
    const saved = await storage.save("a mug", Buffer.from("png"), {});
    const link = join(await mkdtemp(join(tmpdir(), "darkroom-link-")), "out");
    await symlink(dir, link);
    try {
      expect(await storage.find(join(link, basename(saved.pngPath)))).toEqual(saved);
    } finally {
      await rm(dirname(link), { recursive: true, force: true });
    }
  });

  it.each([
    ["a relative path", "out/a-mug-0123abcd.png", /absolute path or just its filename/],
    ["a path outside the output folder", "/etc/a-mug-0123abcd.png", /isn't in Darkroom's output folder/],
    ["a folder that doesn't exist", "/no/such/dir/a-mug-0123abcd.png", /No image at/],
    ["a traversal", "../a-mug-0123abcd.png", /absolute path or just its filename/],
    ["a name save() never writes", "passwd", /isn't a Darkroom image name/],
    ["the sidecar's name", "a-mug-0123abcd.json", /isn't a Darkroom image name/],
    ["the spend ledger", "spend-ledger.json", /isn't a Darkroom image name/],
    ["a missing image", "a-mug-0123abcd.png", /No image at/],
  ])("refuses %s", async (_, ref, message) => {
    await expect(storage.find(ref)).rejects.toThrow(message);
  });

  it("refuses a filename once the output folder is swapped for a symlink, as it does a path (review C6)", async () => {
    const saved = await storage.save("a mug", Buffer.from("png"), {});
    const elsewhere = await mkdtemp(join(tmpdir(), "darkroom-elsewhere-"));
    try {
      await rename(storage.root, `${storage.root}-moved`);
      await symlink(elsewhere, storage.root);
      await writeFile(join(elsewhere, basename(saved.pngPath)), "other png");
      await writeFile(join(elsewhere, basename(saved.sidecarPath)), "{}");
      // check_contrast only reads, so the refusal mustn't talk about writing.
      await expect(storage.find(basename(saved.pngPath))).rejects.toThrow(/resolves elsewhere; refusing to use it/);
      await expect(storage.find(saved.pngPath)).rejects.toThrow(StorageError);
    } finally {
      await rm(storage.root, { force: true });
      await rename(`${storage.root}-moved`, storage.root);
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("doesn't recreate a deleted output folder just to look an image up", async () => {
    const images = await Storage.open(join(dir, "images"));
    await rm(images.root, { recursive: true });
    await expect(images.find("a-mug-0123abcd.png")).rejects.toThrow(/output folder .* doesn't exist/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("says there's no image when a path runs through a file, not a raw ENOTDIR (review C5)", async () => {
    const file = join(dir, "not-a-folder");
    await writeFile(file, "x");
    // The folder part runs through the file, which is what makes realpath fail with ENOTDIR.
    const ref = join(file, "inner", "a-mug-0123abcd.png");
    await expect(storage.find(ref)).rejects.toThrow(new StorageError(`No image at ${ref}.`));
  });

  it.skipIf(process.getuid?.() === 0)("turns a permission error on the path into a StorageError (review C5)", async () => {
    const locked = join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      await expect(storage.find(join(locked, "inner", "a-mug-0123abcd.png"))).rejects.toThrow(StorageError);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it("refuses an image whose sidecar is gone", async () => {
    const saved = await storage.save("a mug", Buffer.from("png"), {});
    await rm(saved.sidecarPath);
    await expect(storage.find(saved.pngPath)).rejects.toThrow(/No metadata sidecar at/);
  });

  it("refuses a symlink planted in the output folder", async () => {
    const outside = join(await mkdtemp(join(tmpdir(), "darkroom-outside-")), "secret.png");
    await writeFile(outside, "secret");
    await symlink(outside, join(dir, "evil-0123abcd.png"));
    await writeFile(join(dir, "evil-0123abcd.json"), "{}");
    try {
      await expect(storage.find("evil-0123abcd.png")).rejects.toThrow(/No image at/);
    } finally {
      await rm(dirname(outside), { recursive: true, force: true });
    }
  });

  it("refuses a folder named like an image", async () => {
    await mkdir(join(dir, "odd-0123abcd.png"));
    await writeFile(join(dir, "odd-0123abcd.json"), "{}");
    await expect(storage.find("odd-0123abcd.png")).rejects.toThrow(/No image at/);
  });
});

describe("Storage.updateSidecar", () => {
  let dir: string;
  let storage: Storage;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "darkroom-update-"));
    storage = await Storage.open(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const read = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

  it("rewrites the sidecar, returns what it was, and leaves no temp file", async () => {
    const saved = await storage.save("a mug", Buffer.from("png"), { provider: "mock" });
    const before = await storage.updateSidecar(saved.sidecarPath, (s) => ({ ...s, alt_text: "A mug." }));
    expect(before).toEqual({ image: basename(saved.pngPath), provider: "mock" });
    expect(await read(saved.sidecarPath)).toEqual({ ...before, alt_text: "A mug." });
    expect((await readdir(dir)).sort()).toEqual([basename(saved.sidecarPath), basename(saved.pngPath)].sort());
  });

  it("applies concurrent updates one after another, so none is lost", async () => {
    const saved = await storage.save("a mug", Buffer.from("png"), {});
    await Promise.all(
      ["a", "b", "c", "d"].map((key) => storage.updateSidecar(saved.sidecarPath, (s) => ({ ...s, [key]: true }))),
    );
    expect(await read(saved.sidecarPath)).toMatchObject({ a: true, b: true, c: true, d: true });
  });

  it("keeps going after a failed update", async () => {
    const saved = await storage.save("a mug", Buffer.from("png"), {});
    const failing = storage.updateSidecar(saved.sidecarPath, () => {
      throw new Error("boom");
    });
    const next = storage.updateSidecar(saved.sidecarPath, (s) => ({ ...s, ok: true }));
    await expect(failing).rejects.toThrow("boom");
    await next;
    expect(await read(saved.sidecarPath)).toMatchObject({ ok: true });
  });

  it.each([
    ["broken JSON", "{not json", /isn't valid JSON/],
    ["a JSON array", "[]", /isn't a JSON object/],
  ])("leaves %s untouched", async (_, content, message) => {
    const path = join(storage.root, "x-0123abcd.json");
    await writeFile(path, content);
    await expect(storage.updateSidecar(path, (s) => s)).rejects.toThrow(message);
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it("refuses a path outside the output folder", async () => {
    await expect(storage.updateSidecar("/etc/x-0123abcd.json", (s) => s)).rejects.toThrow(StorageError);
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
