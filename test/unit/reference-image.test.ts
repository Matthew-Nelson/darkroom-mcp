import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nearestAspectRatio } from "../../src/providers/sizes.js";
import {
  loadReferenceImage,
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_EDGE,
  ReferenceImageError,
} from "../../src/reference-image.js";
import { Storage } from "../../src/storage.js";

const solid = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#3366cc" } });

describe("nearestAspectRatio", () => {
  it.each([
    [1000, 1000, "1:1"],
    [1100, 1000, "1:1"],
    [1500, 1000, "3:2"],
    [1000, 1500, "2:3"],
    [4032, 3024, "3:2"], // a 4:3 phone photo
    [3024, 4032, "2:3"],
    [1920, 1080, "16:9"],
    [1080, 1920, "9:16"],
    [3000, 1000, "16:9"], // wider than anything supported
    [1000, 3000, "9:16"],
  ] as const)("%i×%i -> %s", (w, h, expected) => {
    expect(nearestAspectRatio(w, h)).toBe(expected);
  });
});

describe("loadReferenceImage", () => {
  let dir: string;
  let outDir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "darkroom-ref-")));
    outDir = join(dir, "out");
    storage = await Storage.open(outDir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function file(name: string, bytes: Buffer): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, bytes);
    return path;
  }

  it.each(["png", "jpeg", "webp"] as const)("loads a %s by absolute path and re-encodes it as PNG", async (format) => {
    const bytes = await solid(300, 200).toFormat(format).toBuffer();
    const path = await file(`photo.${format}`, bytes);
    const ref = await loadReferenceImage(path, storage);
    expect(ref.path).toBe(path);
    expect(ref.format).toBe(format);
    expect(ref.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect([ref.originalWidth, ref.originalHeight]).toEqual([300, 200]);
    const meta = await sharp(ref.image.png).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 300, 200]);
    expect([ref.image.width, ref.image.height]).toEqual([300, 200]);
  });

  it("finds an image Darkroom saved by its filename", async () => {
    const saved = await storage.save("a mug", await solid(128, 128).png().toBuffer(), {});
    const name = saved.pngPath.slice(outDir.length + 1);
    const ref = await loadReferenceImage(name, storage);
    expect(ref.path).toBe(saved.pngPath);
  });

  it("explains how to pass any other image when a bare filename isn't a Darkroom image", async () => {
    await expect(loadReferenceImage("holiday.jpg", storage)).rejects.toThrow(/isn't a Darkroom image name.*absolute path/s);
  });

  it("turns a photo upright by its EXIF orientation and drops the EXIF data", async () => {
    // Orientation 6: stored 300 wide by 200 tall, shown rotated 90° clockwise.
    const bytes = await solid(300, 200)
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Artist: "someone" } } })
      .toBuffer();
    const ref = await loadReferenceImage(await file("rotated.jpg", bytes), storage);
    expect([ref.originalWidth, ref.originalHeight]).toEqual([200, 300]);
    const meta = await sharp(ref.image.png).metadata();
    expect([meta.width, meta.height]).toEqual([200, 300]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it(`downscales anything over ${MAX_REFERENCE_EDGE}px on the long edge, keeping its shape`, async () => {
    const ref = await loadReferenceImage(await file("big.png", await solid(4000, 2000).png().toBuffer()), storage);
    expect([ref.image.width, ref.image.height]).toEqual([MAX_REFERENCE_EDGE, MAX_REFERENCE_EDGE / 2]);
    expect([ref.originalWidth, ref.originalHeight]).toEqual([4000, 2000]);
  });

  it("follows a symlink and reports the real path", async () => {
    const real = await file("real.png", await solid(100, 100).png().toBuffer());
    const link = join(dir, "link.png");
    await symlink(real, link);
    expect((await loadReferenceImage(link, storage)).path).toBe(real);
  });

  it("refuses a relative path", async () => {
    await expect(loadReferenceImage("pics/photo.png", storage)).rejects.toThrow(/absolute path/);
  });

  it("refuses a missing file", async () => {
    await expect(loadReferenceImage(join(dir, "nope.png"), storage)).rejects.toThrow(/No file at/);
  });

  it("refuses a directory", async () => {
    await mkdir(join(dir, "folder.png"));
    await expect(loadReferenceImage(join(dir, "folder.png"), storage)).rejects.toThrow(/isn't a regular file/);
  });

  it("refuses a named pipe without waiting for a writer", async () => {
    const fifo = join(dir, "pipe.png");
    execFileSync("mkfifo", [fifo]);
    await expect(loadReferenceImage(fifo, storage)).rejects.toThrow(/isn't a regular file/);
  });

  it("refuses a file that isn't an image, without quoting it", async () => {
    const path = await file("secrets.png", Buffer.from("API_KEY=sk-not-a-real-key\n"));
    const err = await loadReferenceImage(path, storage).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReferenceImageError);
    expect((err as Error).message).toMatch(/isn't a PNG, JPEG, or WebP/);
    expect((err as Error).message).not.toContain("API_KEY");
  });

  it("refuses an image in another format", async () => {
    const path = await file("anim.gif", await solid(100, 100).gif().toBuffer());
    await expect(loadReferenceImage(path, storage)).rejects.toThrow(/isn't a PNG, JPEG, or WebP/);
  });

  it("refuses a tiny image", async () => {
    const path = await file("icon.png", await solid(32, 200).png().toBuffer());
    await expect(loadReferenceImage(path, storage)).rejects.toThrow(/32×200.*at least 64px/);
  });

  it("refuses a file over the size cap before reading it", async () => {
    const path = join(dir, "huge.png");
    await writeFile(path, "");
    execFileSync("truncate", ["-s", String(MAX_REFERENCE_BYTES + 1), path]);
    await expect(loadReferenceImage(path, storage)).rejects.toThrow(/at most 50MB/);
  });
});
