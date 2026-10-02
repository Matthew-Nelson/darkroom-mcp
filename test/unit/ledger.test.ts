import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapExceededError, Ledger, LEDGER_FILENAME, LedgerError } from "../../src/ledger.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "darkroom-ledger-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const clock = (iso: string) => {
  const c = { now: new Date(iso) };
  return { c, now: () => c.now };
};

const readLedger = async () =>
  JSON.parse(await readFile(join(dir, LEDGER_FILENAME), "utf8")) as {
    days: Record<string, { state: string; amount_usd: number; amount_is_estimate: boolean }[]>;
  };

describe("Ledger", () => {
  it("starts at zero with no file", async () => {
    expect(await Ledger.inDir(dir).spentTodayUsd()).toBe(0);
  });

  it("counts a reservation at its estimate, then at the actual cost once settled", async () => {
    const ledger = Ledger.inDir(dir);
    const r = await ledger.reserve({ provider: "openai", estimateUsd: 0.08, capUsd: 2 });
    expect(await ledger.spentTodayUsd()).toBe(0.08);
    await ledger.settle(r, 0.052);
    expect(await ledger.spentTodayUsd()).toBe(0.052);
    const day = (await readLedger()).days[ledger.today()];
    expect(day).toMatchObject([{ state: "settled", amount_usd: 0.052, amount_is_estimate: false }]);
  });

  it("keeps the estimate when the provider reports no actual cost", async () => {
    const ledger = Ledger.inDir(dir);
    await ledger.settle(await ledger.reserve({ provider: "openai", estimateUsd: 0.08, capUsd: 2 }), undefined);
    expect(await ledger.spentTodayUsd()).toBe(0.08);
    expect((await readLedger()).days[ledger.today()]).toMatchObject([{ state: "settled", amount_is_estimate: true }]);
  });

  it("keeps the estimate after an ambiguous failure and drops it after a no-charge failure", async () => {
    const ledger = Ledger.inDir(dir);
    await ledger.keep(await ledger.reserve({ provider: "openai", estimateUsd: 0.08, capUsd: 2 }), "timed out");
    await ledger.release(await ledger.reserve({ provider: "openai", estimateUsd: 0.08, capUsd: 2 }), "HTTP 401");
    expect(await ledger.spentTodayUsd()).toBe(0.08);
    expect((await readLedger()).days[ledger.today()]?.map((e) => e.state)).toEqual(["kept", "released"]);
  });

  it("refuses a reservation that would exceed the cap and records nothing", async () => {
    const ledger = Ledger.inDir(dir);
    await ledger.reserve({ provider: "openai", estimateUsd: 0.06, capUsd: 0.1 });
    const err = await ledger.reserve({ provider: "openai", estimateUsd: 0.06, capUsd: 0.1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapExceededError);
    expect((err as Error).message).toBe(
      "daily spend cap reached: $0.06 of $0.10 already spent or reserved today (UTC), and this request needs about $0.0600. " +
        "Raise DARKROOM_DAILY_CAP_USD, or wait for the UTC day to roll over",
    );
    expect(await ledger.spentTodayUsd()).toBe(0.06);
  });

  it("allows spending exactly up to the cap, without float drift", async () => {
    const ledger = Ledger.inDir(dir);
    for (let i = 0; i < 3; i++) await ledger.reserve({ provider: "openai", estimateUsd: 0.1, capUsd: 0.3 });
    expect(await ledger.spentTodayUsd()).toBe(0.3);
    await expect(ledger.reserve({ provider: "openai", estimateUsd: 0.000001, capUsd: 0.3 })).rejects.toThrow(
      CapExceededError,
    );
  });

  it("refuses every paid call with a $0 cap", async () => {
    await expect(Ledger.inDir(dir).reserve({ provider: "openai", estimateUsd: 0.01, capUsd: 0 })).rejects.toThrow(
      CapExceededError,
    );
  });

  it("lets only as many parallel reservations through as fit under the cap", async () => {
    const ledger = Ledger.inDir(dir);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => ledger.reserve({ provider: "openai", estimateUsd: 0.03, capUsd: 0.1 })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof CapExceededError)).toHaveLength(7);
    expect(await ledger.spentTodayUsd()).toBe(0.09);
  });

  it("sees spend recorded by another process (another Ledger on the same file)", async () => {
    await Ledger.inDir(dir).reserve({ provider: "openai", estimateUsd: 0.08, capUsd: 0.1 });
    await expect(Ledger.inDir(dir).reserve({ provider: "openai", estimateUsd: 0.08, capUsd: 0.1 })).rejects.toThrow(
      CapExceededError,
    );
  });

  it("rolls over at UTC midnight, not local midnight", async () => {
    const { c, now } = clock("2026-10-02T23:59:59.000Z");
    const ledger = Ledger.inDir(dir, { now });
    const late = await ledger.reserve({ provider: "openai", estimateUsd: 0.1, capUsd: 0.1 });
    expect(ledger.today()).toBe("2026-10-02");

    c.now = new Date("2026-10-03T00:00:00.000Z");
    expect(ledger.today()).toBe("2026-10-03");
    expect(await ledger.spentTodayUsd()).toBe(0);
    await ledger.reserve({ provider: "openai", estimateUsd: 0.1, capUsd: 0.1 });

    // A reservation made before midnight settles against the day it was made.
    await ledger.settle(late, 0.04);
    const days = (await readLedger()).days;
    expect(days["2026-10-02"]).toMatchObject([{ state: "settled", amount_usd: 0.04 }]);
    expect(days["2026-10-03"]).toMatchObject([{ state: "reserved", amount_usd: 0.1 }]);
  });

  it("leaves no temp files behind", async () => {
    const ledger = Ledger.inDir(dir);
    await ledger.settle(await ledger.reserve({ provider: "openai", estimateUsd: 0.01, capUsd: 2 }), 0.01);
    expect(await readdir(dir)).toEqual([LEDGER_FILENAME]);
  });

  it("fails closed on a corrupt ledger and leaves it untouched", async () => {
    const path = join(dir, LEDGER_FILENAME);
    await writeFile(path, "{ not json");
    const ledger = Ledger.inDir(dir);
    await expect(ledger.reserve({ provider: "openai", estimateUsd: 0.01, capUsd: 2 })).rejects.toThrow(LedgerError);
    await expect(ledger.spentTodayUsd()).rejects.toThrow(/is corrupt, so paid providers are blocked/);
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });

  it("rejects a ledger with the wrong shape", async () => {
    await writeFile(join(dir, LEDGER_FILENAME), JSON.stringify({ version: 1, days: { "2026-10-02": [{ id: 1 }] } }));
    await expect(Ledger.inDir(dir).spentTodayUsd()).rejects.toThrow(LedgerError);
  });

  it("keeps working after a failed operation", async () => {
    const ledger = Ledger.inDir(dir);
    await expect(ledger.reserve({ provider: "openai", estimateUsd: 1, capUsd: 0.5 })).rejects.toThrow();
    await expect(ledger.reserve({ provider: "openai", estimateUsd: 0.1, capUsd: 0.5 })).resolves.toMatchObject({
      estimateUsd: 0.1,
    });
  });
});
