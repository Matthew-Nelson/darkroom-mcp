import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import sharp from "sharp";

const MAX_SLUG_LENGTH = 60;

// What save() names a PNG and its sidecar: a slug, a hyphen, and 8 hex digits.
const IMAGE_NAME = /^[a-z0-9-]+-[0-9a-f]{8}\.png$/;
export const SIDECAR_NAME = /^[a-z0-9-]+-[0-9a-f]{8}\.json$/;
export const PREVIEW_MAX_EDGE = 768;
// The folders save() files images into: a local date, optionally with a project and session.
export const SUBFOLDER_NAME = /^\d{4}-\d{2}-\d{2}(_[a-z0-9-]+_[0-9a-f]{8})?$/;

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

/** The Claude Code session the server runs in, from the environment Claude Code gives it. */
export interface ClaudeSession {
  projectDir: string;
  sessionId: string;
}

/**
 * Names the subfolder each image is saved in. A Claude Code session gets one folder for
 * its whole life, named when the server starts, so a session that runs past midnight
 * isn't split. Without one, images go into a folder per local date.
 */
export function subfolderNamer(session: ClaudeSession | undefined, now: () => Date = () => new Date()): () => string {
  if (session === undefined) return () => localDate(now());
  const name = `${localDate(now())}_${slugify(basename(session.projectDir))}_${session.sessionId.slice(0, 8).toLowerCase()}`;
  return () => name;
}

// Local, not UTC like the spend ledger: the folders are for a person browsing them.
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface SavedImage {
  pngPath: string;
  sidecarPath: string;
}

export class Storage {
  // One sidecar rewrite at a time per file, so concurrent updates can't drop each other's fields.
  private readonly sidecarQueues = new Map<string, Promise<unknown>>();

  private constructor(
    readonly root: string,
    private readonly subfolder: (() => string) | undefined,
  ) {}

  /**
   * Creates the output directory if needed and pins its canonical (symlink-free) path.
   * With `subfolder`, images are saved one level down, in the folder it names.
   */
  static async open(outputDir: string, opts: { subfolder?: () => string } = {}): Promise<Storage> {
    await mkdir(outputDir, { recursive: true });
    return new Storage(await realpath(outputDir), opts.subfolder);
  }

  /**
   * Writes `<slug>-<id>.png` and its `<slug>-<id>.json` sidecar. Never overwrites:
   * files are created exclusively, which also refuses to follow a planted symlink.
   */
  async save(name: string, png: Buffer, metadata: Record<string, unknown>): Promise<SavedImage> {
    await this.checkRoot({ create: true });
    const dir = this.subfolder === undefined ? this.root : await this.makeSubfolder(this.subfolder());
    const slug = slugify(name);
    for (let attempt = 0; attempt < 3; attempt++) {
      const stem = `${slug}-${randomBytes(4).toString("hex")}`;
      const pngPath = join(dir, `${stem}.png`);
      const sidecarPath = join(dir, `${stem}.json`);
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

  /**
   * Finds a saved image from what a tool caller passes: the PNG's absolute path, as
   * generate_image and list_images return it, or just its filename. Only images
   * save() could have written are found: at the top of the output directory (where
   * they went before subfolders) or one level down in a folder save() names.
   */
  async find(ref: string): Promise<SavedImage> {
    // A filename is joined onto the root, so the root must still be the folder pinned at startup.
    await this.checkRoot({ create: false });
    const name = basename(ref);
    let dir: string | undefined;
    if (name !== ref) {
      if (!isAbsolute(ref)) {
        throw new StorageError(`Pass the image's absolute path or just its filename, not a relative path: ${ref}`);
      }
      try {
        dir = await realpath(dirname(ref));
      } catch (err) {
        if (isErrno(err, "ENOENT") || isErrno(err, "ENOTDIR")) throw new StorageError(`No image at ${ref}.`);
        // Any other failure (permissions, say) still means it can't be shown to be the output folder.
        const reason = err instanceof Error ? err.message : String(err);
        throw new StorageError(`Can't check that ${ref} is in Darkroom's output folder: ${reason}`);
      }
      if (!this.isImageDir(dir)) throw new StorageError(`${ref} isn't in Darkroom's output folder (${this.root}).`);
    }
    if (!IMAGE_NAME.test(name)) {
      throw new StorageError(
        `${name} isn't a Darkroom image name (<name>-<8 hex digits>.png). Use a path from generate_image or list_images.`,
      );
    }
    if (dir === undefined) {
      const dirs = [];
      for (const d of await imageDirs(this.root)) if (await isFile(join(d, name))) dirs.push(d);
      if (dirs.length > 1) {
        throw new StorageError(`${name} is in more than one folder (${dirs.join(", ")}); pass its full path instead.`);
      }
      dir = dirs[0] ?? this.root;
    }
    const pngPath = join(dir, name);
    const sidecarPath = pngPath.replace(/\.png$/, ".json");
    for (const [path, what] of [[pngPath, "image"], [sidecarPath, "metadata sidecar"]] as const) {
      if (!(await isFile(path))) throw new StorageError(`No ${what} at ${path}.`);
    }
    return { pngPath, sidecarPath };
  }

  private isImageDir(dir: string): boolean {
    return dir === this.root || (dirname(dir) === this.root && SUBFOLDER_NAME.test(basename(dir)));
  }

  /** Creates a subfolder of the output directory, refusing one that's been swapped for a symlink. */
  private async makeSubfolder(name: string): Promise<string> {
    const dir = join(this.root, name);
    assertInside(this.root, dir);
    await mkdir(dir).catch((err: unknown) => {
      if (!isErrno(err, "EEXIST")) throw err;
    });
    // lstat, not stat: a symlink isn't a directory here, so it's refused rather than followed.
    if (!(await lstat(dir)).isDirectory()) throw new StorageError(`${dir} isn't a folder; refusing to save into it.`);
    return dir;
  }

  /**
   * Rewrites a sidecar with `update`'s result, atomically: the new JSON goes to a
   * temp file that's renamed over the old one, so a crash never leaves half a file.
   * Returns the sidecar as it was before the update.
   */
  async updateSidecar(
    sidecarPath: string,
    update: (sidecar: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const queued = this.sidecarQueues.get(sidecarPath) ?? Promise.resolve();
    const run = queued.then(() => this.rewriteSidecar(sidecarPath, update));
    const settled = run.catch(() => undefined);
    this.sidecarQueues.set(sidecarPath, settled);
    void settled.then(() => {
      if (this.sidecarQueues.get(sidecarPath) === settled) this.sidecarQueues.delete(sidecarPath);
    });
    return run;
  }

  private async rewriteSidecar(
    sidecarPath: string,
    update: (sidecar: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.checkRoot({ create: true });
    assertInside(this.root, sidecarPath);
    if (!(await lstat(sidecarPath)).isFile()) throw new StorageError(`${sidecarPath} isn't a regular file.`);
    let before: unknown;
    try {
      before = JSON.parse(await readFile(sidecarPath, "utf8"));
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      throw new StorageError(`${sidecarPath} isn't valid JSON, so it wasn't changed.`);
    }
    if (typeof before !== "object" || before === null || Array.isArray(before)) {
      throw new StorageError(`${sidecarPath} isn't a JSON object, so it wasn't changed.`);
    }
    const sidecar = before as Record<string, unknown>;
    // Dot-prefixed with a .tmp suffix, so list_images never mistakes it for a sidecar.
    const tmpPath = join(this.root, `.${basename(sidecarPath)}.${randomBytes(4).toString("hex")}.tmp`);
    const json = `${JSON.stringify(update({ ...sidecar }), null, 2)}\n`;
    try {
      // Inside the try: a write that fails partway (a full disk) has already created the temp file.
      await writeFile(tmpPath, json, { flag: "wx" });
      await rename(tmpPath, sidecarPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
    return sidecar;
  }

  private async checkRoot({ create }: { create: boolean }): Promise<void> {
    let real: string;
    try {
      real = await realpath(this.root);
    } catch (err) {
      if (!isErrno(err, "ENOENT")) throw err;
      // A lookup only reads, so it reports the folder gone rather than making an empty one.
      if (!create) throw new StorageError(`Darkroom's output folder ${this.root} doesn't exist.`);
      // Deleted while the server runs: recreate it rather than lose a (possibly paid) image.
      await mkdir(this.root, { recursive: true });
      real = await realpath(this.root);
    }
    // If the output dir was swapped for a symlink since startup, its real path moves.
    if (real !== this.root) {
      throw new StorageError(`Output directory ${this.root} now resolves elsewhere; refusing to use it.`);
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

/**
 * The folders saved images can be in: the output directory itself, then its subfolders
 * named like save()'s, oldest first. Symlinked folders aren't followed.
 */
export async function imageDirs(root: string): Promise<string[]> {
  const subfolders = (await readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && SUBFOLDER_NAME.test(e.name))
    .map((e) => e.name)
    .sort();
  return [root, ...subfolders.map((name) => join(root, name))];
}

// lstat, not stat: a symlink planted in the folder isn't followed.
async function isFile(path: string): Promise<boolean> {
  return lstat(path).then(
    (s) => s.isFile(),
    (err: unknown) => {
      if (isErrno(err, "ENOENT")) return false;
      throw err;
    },
  );
}

export function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}
