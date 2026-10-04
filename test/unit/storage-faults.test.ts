import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A write that creates the file and then fails partway, as a full disk would (review C1).
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    writeFile: vi.fn(async (...args: Parameters<typeof real.writeFile>) => {
      const [path] = args;
      if (typeof path === "string" && path.endsWith(".tmp")) {
        await real.writeFile(path, "{ half", { flag: "wx" });
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return real.writeFile(...args);
    }),
  };
});

const { Storage } = await import("../../src/storage.js");

describe("Storage.updateSidecar when the disk fills", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "darkroom-faults-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("removes the half-written temp file and leaves the sidecar as it was", async () => {
    const storage = await Storage.open(dir);
    const saved = await storage.save("a mug", Buffer.from("png"), { provider: "mock" });
    await expect(storage.updateSidecar(saved.sidecarPath, (s) => ({ ...s, alt_text: "x" }))).rejects.toThrow(/ENOSPC/);
    expect((await readdir(storage.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
