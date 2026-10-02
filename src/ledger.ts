import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

// Daily paid spend, kept as a JSON file in the output directory and keyed by UTC
// date. Every paid call reserves its estimate first and settles afterwards, so
// parallel calls can't all pass the cap check. Each operation re-reads the file,
// so separate Claude Code sessions (separate processes) see each other's spend.
// There is no cross-process lock: two sessions writing in the same instant can
// both pass the cap check, or one can erase the other's fresh reservation. The
// latter is repaired when that call settles (see close()), so its spend still
// counts; until then other sessions don't see it. That is the accepted race.

export const LEDGER_FILENAME = "spend-ledger.json";

// Amounts are compared in whole micro-dollars so float drift can't flip a cap check.
const toMicros = (usd: number) => Math.round(usd * 1e6);
const fromMicros = (micros: number) => micros / 1e6;

const EntrySchema = z.object({
  id: z.string(),
  provider: z.string(),
  // reserved: in flight (or the process died mid-call); counts the estimate.
  // settled: finished; amount is the actual cost, or the estimate if none was reported.
  // kept: failed in a way that may still have been billed; the estimate stands.
  // released: failed before any charge; counts nothing.
  state: z.enum(["reserved", "settled", "kept", "released"]),
  estimate_usd: z.number().min(0),
  amount_usd: z.number().min(0),
  amount_is_estimate: z.boolean(),
  reserved_at: z.string(),
  closed_at: z.string().optional(),
  note: z.string().optional(),
});
type Entry = z.infer<typeof EntrySchema>;

const FileSchema = z.object({
  version: z.literal(1),
  days: z.record(z.string(), z.array(EntrySchema)),
});
type LedgerFile = z.infer<typeof FileSchema>;

export interface Reservation {
  id: string;
  day: string; // UTC date the reservation counts against, even if it settles after midnight
  provider: string;
  estimateUsd: number;
  reservedAt: string;
}

export class CapExceededError extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly capUsd: number,
    public readonly neededUsd: number,
  ) {
    super(
      `daily spend cap reached: ${formatUsd(spentUsd)} of ${formatUsd(capUsd)} already spent or reserved today (UTC), ` +
        `and this request needs about ${formatUsd(neededUsd)}. Raise DARKROOM_DAILY_CAP_USD, or wait for the UTC day to roll over`,
    );
    this.name = "CapExceededError";
  }
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export class Ledger {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(
    readonly path: string,
    opts: { now?: () => Date } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  static inDir(dir: string, opts: { now?: () => Date } = {}): Ledger {
    return new Ledger(join(dir, LEDGER_FILENAME), opts);
  }

  /** UTC date, e.g. "2026-10-02". The README notes the day rolls over at UTC midnight. */
  today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /** Total spent or reserved today (UTC). */
  async spentTodayUsd(): Promise<number> {
    return this.locked(async () => fromMicros(dayTotal(await this.read(), this.today())));
  }

  /**
   * Reserves `estimateUsd` against today's cap, or throws CapExceededError
   * without recording anything. The check and the write happen under one lock.
   */
  async reserve(o: { provider: string; estimateUsd: number; capUsd: number }): Promise<Reservation> {
    return this.locked(async () => {
      const file = await this.read();
      const day = this.today();
      const spent = dayTotal(file, day);
      if (spent + toMicros(o.estimateUsd) > toMicros(o.capUsd)) {
        throw new CapExceededError(fromMicros(spent), o.capUsd, o.estimateUsd);
      }
      const entry: Entry = {
        id: randomBytes(6).toString("hex"),
        provider: o.provider,
        state: "reserved",
        estimate_usd: o.estimateUsd,
        amount_usd: o.estimateUsd,
        amount_is_estimate: true,
        reserved_at: this.now().toISOString(),
      };
      (file.days[day] ??= []).push(entry);
      await this.write(file);
      return { id: entry.id, day, provider: o.provider, estimateUsd: o.estimateUsd, reservedAt: entry.reserved_at };
    });
  }

  /** The call succeeded: record its actual cost, or keep the estimate if the provider didn't report one. */
  settle(r: Reservation, actualUsd: number | undefined): Promise<void> {
    return this.close(r, (e) => {
      e.state = "settled";
      if (actualUsd !== undefined) {
        e.amount_usd = actualUsd;
        e.amount_is_estimate = false;
      }
    });
  }

  /** The call failed in a way the provider may still have billed (timeout, dropped connection): the estimate stands. */
  keep(r: Reservation, note: string): Promise<void> {
    return this.close(r, (e) => {
      e.state = "kept";
      e.note = note;
    });
  }

  /** The call failed before the provider could charge (e.g. rejected up front): count nothing. */
  release(r: Reservation, note: string): Promise<void> {
    return this.close(r, (e) => {
      e.state = "released";
      e.amount_usd = 0;
      e.amount_is_estimate = false;
      e.note = note;
    });
  }

  private close(r: Reservation, update: (e: Entry) => void): Promise<void> {
    return this.locked(async () => {
      const file = await this.read();
      let entry = file.days[r.day]?.find((e) => e.id === r.id);
      if (!entry) {
        // Another process rewrote the file after we reserved and erased this entry.
        // Put it back, so the call's spend still counts.
        entry = {
          id: r.id,
          provider: r.provider,
          state: "reserved",
          estimate_usd: r.estimateUsd,
          amount_usd: r.estimateUsd,
          amount_is_estimate: true,
          reserved_at: r.reservedAt,
          note: "restored: a concurrent write from another process had erased this reservation",
        };
        (file.days[r.day] ??= []).push(entry);
      }
      update(entry);
      entry.closed_at = this.now().toISOString();
      await this.write(file);
    });
  }

  /** Runs `fn` after every earlier operation on this ledger, so read-modify-write never interleaves in-process. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<LedgerFile> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return { version: 1, days: {} };
      throw new LedgerError(`Can't read the spend ledger at ${this.path} (${err instanceof Error ? err.message : String(err)}).`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const result = FileSchema.safeParse(parsed);
    if (!result.success) {
      // Fail closed: never overwrite a spend record we can't understand.
      throw new LedgerError(
        `The spend ledger at ${this.path} is corrupt, so paid providers are blocked. ` +
          "It records today's paid spend: fix it, or move it aside if you accept losing that record.",
      );
    }
    return result.data;
  }

  /** Writes to a temp file and renames it into place, so readers never see a half-written ledger. */
  private async write(file: LedgerFile): Promise<void> {
    const tmp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx" });
      await rename(tmp, this.path);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw new LedgerError(`Can't write the spend ledger at ${this.path} (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
}

/** "$2.00", "$0.001", "$0.0915": at least cents, up to four decimals, so sub-cent amounts don't round away. */
function formatUsd(usd: number): string {
  return `$${usd.toFixed(4).replace(/(\.\d{2}\d*?)0+$/, "$1")}`;
}

function dayTotal(file: LedgerFile, day: string): number {
  return (file.days[day] ?? []).reduce((sum, e) => sum + toMicros(e.amount_usd), 0);
}
