import { randomBytes } from "node:crypto";
import { mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import sharp from "sharp";

const MAX_SLUG_LENGTH = 60;
export const PREVIEW_MAX_EDGE = 768;

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

/**
 * Turns a user-supplied filename (or a prompt) into a safe slug: lowercase ASCII
 * letters, digits, and single hyphens. Path separators and dots can't survive, so
 * the result can never point outside the output directory.
 */
export function slugify(input: string): string {
  const slug = input
    .replace(/\.(png|jpe?g|webp|json)$/i, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= MAX_SLUG_LENGTH) return slug || "image";
  // Cut at a word boundary when one is reasonably close to the limit.
  const cut = slug.slice(0, MAX_SLUG_LENGTH);
  const lastHyphen = cut.lastIndexOf("-");
  return (lastHyphen >= MAX_SLUG_LENGTH / 2 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, "");
}

/** Throws unless `candidate` is strictly inside `root` (both absolute). */
export function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new StorageError(`Refusing to write outside the output directory: ${candidate}`);
  }
}

export interface SavedImage {
  pngPath: string;
  sidecarPath: string;
}

export class Storage {
  private constructor(readonly root: string) {}

  /** Creates the output directory if needed and pins its canonical (symlink-free) path. */
  static async open(outputDir: string): Promise<Storage> {
    await mkdir(outputDir, { recursive: true });
    return new Storage(await realpath(outputDir));
  }

  /**
   * Writes `<slug>-<id>.png` and its `<slug>-<id>.json` sidecar. Never overwrites:
   * files are created exclusively, which also refuses to follow a planted symlink.
   */
  async save(name: string, png: Buffer, metadata: Record<string, unknown>): Promise<SavedImage> {
    await this.checkRoot();
    const slug = slugify(name);
    for (let attempt = 0; attempt < 3; attempt++) {
      const stem = `${slug}-${randomBytes(4).toString("hex")}`;
      const pngPath = join(this.root, `${stem}.png`);
      const sidecarPath = join(this.root, `${stem}.json`);
      assertInside(this.root, pngPath);
      assertInside(this.root, sidecarPath);
      try {
        await writeFile(pngPath, png, { flag: "wx" });
      } catch (err) {
        if (isErrno(err, "EEXIST")) continue;
        throw err;
      }
      try {
        const sidecar = { image: basename(pngPath), ...metadata };
        await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, { flag: "wx" });
      } catch (err) {
        await unlink(pngPath).catch(() => undefined);
        throw err;
      }
      return { pngPath, sidecarPath };
    }
    throw new StorageError("Could not find a free filename after 3 attempts.");
  }

  private async checkRoot(): Promise<void> {
    let real: string;
    try {
      real = await realpath(this.root);
    } catch (err) {
      if (!isErrno(err, "ENOENT")) throw err;
      // Deleted while the server runs: recreate it rather than lose a (possibly paid) image.
      await mkdir(this.root, { recursive: true });
      real = await realpath(this.root);
    }
    // If the output dir was swapped for a symlink since startup, its real path moves.
    if (real !== this.root) {
      throw new StorageError(`Output directory ${this.root} now resolves elsewhere; refusing to write.`);
    }
  }
}

/**
 * Writes a PNG that couldn't be saved to the output directory into the system temp
 * folder instead, and returns its path, so a (possibly paid) image is never lost
 * to a disk problem. Throws if that fails too.
 */
export async function rescuePng(png: Buffer, name: string): Promise<string> {
  const path = join(tmpdir(), `darkroom-rescue-${slugify(name)}-${randomBytes(4).toString("hex")}.png`);
  await writeFile(path, png, { flag: "wx" });
  return path;
}

/** A JPEG preview for Claude to see, at most PREVIEW_MAX_EDGE on the long edge. */
export async function makePreview(png: Buffer): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png)
    .resize(PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { jpeg: data, width: info.width, height: info.height };
}

export function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}
