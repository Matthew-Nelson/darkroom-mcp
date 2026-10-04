import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import sharp, { type OutputInfo } from "sharp";
import type { ReferenceImage } from "./providers/types.js";
import { isErrno, type Storage } from "./storage.js";

// Loads the image a generate_image call is based on. Any local PNG, JPEG, or WebP
// can be one (Matt, Oct 4, 2026), so a user can edit their own photos or logos.
// It's decoded and re-encoded here, before any provider sees it: that refuses
// anything that isn't an image before a network call, turns photos upright by
// their EXIF orientation, drops metadata such as GPS location, and caps the size.

// Above OpenAI's per-image limit, so no real photo is refused for size alone.
export const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;
// Larger references only add upload size and input tokens: every provider renders at about 1MP.
export const MAX_REFERENCE_EDGE = 2048;
// Smaller than this, there's nothing for a provider to keep.
export const MIN_REFERENCE_EDGE = 64;

const FORMATS = new Set(["png", "jpeg", "webp"]);

export class ReferenceImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceImageError";
  }
}

export interface LoadedReference {
  image: ReferenceImage;
  path: string; // absolute, with symlinks resolved
  sha256: string; // of the file as it was on disk
  format: string;
  originalWidth: number; // upright, before any downscaling
  originalHeight: number;
}

/**
 * Finds and loads a reference image: an absolute path to any local PNG, JPEG, or
 * WebP, or just the filename of an image Darkroom saved.
 */
export async function loadReferenceImage(ref: string, storage: Storage): Promise<LoadedReference> {
  const path = await resolve(ref, storage);
  const bytes = await readCapped(path);

  const meta = await sharp(bytes)
    .metadata()
    .catch(() => undefined);
  if (!meta?.format || !FORMATS.has(meta.format) || !meta.width || !meta.height) {
    throw new ReferenceImageError(`${path} isn't a PNG, JPEG, or WebP image that can be read.`);
  }
  // EXIF orientations 5–8 swap the sides once the image is turned upright.
  const swapped = (meta.orientation ?? 1) >= 5;
  const originalWidth = swapped ? meta.height : meta.width;
  const originalHeight = swapped ? meta.width : meta.height;
  if (Math.min(originalWidth, originalHeight) < MIN_REFERENCE_EDGE) {
    throw new ReferenceImageError(
      `${path} is ${originalWidth}×${originalHeight}; a reference image needs at least ${MIN_REFERENCE_EDGE}px on each side.`,
    );
  }

  let out: { data: Buffer; info: OutputInfo };
  try {
    // sharp writes no metadata unless asked, so EXIF (and any GPS position in it) is dropped here.
    out = await sharp(bytes)
      .rotate()
      .resize(MAX_REFERENCE_EDGE, MAX_REFERENCE_EDGE, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ReferenceImageError(`${path} couldn't be decoded (${reason}).`);
  }
  return {
    image: { png: out.data, width: out.info.width, height: out.info.height },
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    format: meta.format,
    originalWidth,
    originalHeight,
  };
}

async function resolve(ref: string, storage: Storage): Promise<string> {
  // A bare filename means an image Darkroom saved; find() applies its own checks.
  if (basename(ref) === ref) {
    try {
      return (await storage.find(ref)).pngPath;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ReferenceImageError(`${reason} For any other image, pass its absolute path.`);
    }
  }
  if (!isAbsolute(ref)) {
    throw new ReferenceImageError(`Pass the reference image's absolute path, not a relative one: ${ref}`);
  }
  try {
    return await realpath(ref);
  } catch (err) {
    if (isErrno(err, "ENOENT") || isErrno(err, "ENOTDIR")) throw new ReferenceImageError(`No file at ${ref}.`);
    const reason = err instanceof Error ? err.message : String(err);
    throw new ReferenceImageError(`Can't open ${ref}: ${reason}`);
  }
}

/** Reads a regular file, refusing one over MAX_REFERENCE_BYTES before reading it all. */
async function readCapped(path: string): Promise<Buffer> {
  let handle;
  try {
    // Non-blocking, so a named pipe can't hang the call waiting for a writer; it's refused below.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ReferenceImageError(`Can't open ${path}: ${reason}`);
  }
  try {
    // Checked on the open handle, so the file can't be swapped between the check and the read.
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ReferenceImageError(`${path} isn't a regular file.`);
    if (stat.size > MAX_REFERENCE_BYTES) {
      const mb = (n: number) => `${Math.round(n / 1024 / 1024)}MB`;
      throw new ReferenceImageError(`${path} is ${mb(stat.size)}; reference images can be at most ${mb(MAX_REFERENCE_BYTES)}.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
