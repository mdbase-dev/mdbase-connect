/**
 * The dual journal: independent browser and vault-file copies.
 *
 * Every batch goes to **both** an IndexedDB `strict` store and an append-only
 * vault file, and is acknowledged only when both writes resolve:
 * - IndexedDB requests strict durability but can be removed by "Clear storage";
 * - the vault file survives "Clear storage" and reinstalls but loses its recent
 *   tail on power loss (no fsync).
 *
 * Recovery takes the **union** by highest version per key. Deletes are carried as
 * entries until compaction. After compaction a copy no longer holds them, so each
 * copy records a `floor`: a key that copy X holds at version `v` is dropped from
 * the union when another healthy copy Y has `floor ≥ v` and doesn't hold the key.
 * In that case Y saw the key deleted and compacted it away. Without the floor, a
 * compacted delete would come back from the other copy.
 *
 * When the copies disagree after load (one evicted, one torn), both are rewritten
 * from the union, so the next crash starts from two good copies.
 */

import { checkEntry, entryId, JournalError, type CopyLoad, type JournalCopy, type JournalEntry } from "./types.js";

/** What load found, for diagnostics and the store's incident reporting. */
export interface DualLoadReport {
  readonly copies: readonly { readonly name: string; readonly state: CopyLoad["state"]; readonly entries: number; readonly damaged: number }[];
  /** The copies disagreed and were rewritten from the union. */
  readonly repaired: boolean;
}

/** Union of copies by highest version, honouring compaction floors. Exported for tests. */
export function unionCopies(loads: readonly CopyLoad[]): Map<string, JournalEntry> {
  const usable = loads.filter((l) => l.state === "ok");
  const byCopy = usable.map((l) => {
    const m = new Map<string, JournalEntry>();
    for (const e of l.entries) {
      const id = entryId(e.space, e.key);
      const cur = m.get(id);
      if (!cur || cur.version < e.version) m.set(id, e);
    }
    return { floor: l.floor, m };
  });
  const out = new Map<string, JournalEntry>();
  for (let i = 0; i < byCopy.length; i++) {
    for (const [id, e] of byCopy[i]!.m) {
      const deletedElsewhere = byCopy.some((other, j) => j !== i && !other.m.has(id) && other.floor >= e.version);
      if (deletedElsewhere) continue;
      const cur = out.get(id);
      if (!cur || cur.version < e.version) out.set(id, e);
    }
  }
  return out;
}

function sameContent(l: CopyLoad, union: Map<string, JournalEntry>): boolean {
  if (l.state !== "ok") return false;
  const live = l.entries.filter((e) => e.value !== null);
  const want = [...union.values()].filter((e) => e.value !== null);
  if (live.length !== want.length) return false;
  for (const e of live) {
    const u = union.get(entryId(e.space, e.key));
    if (!u || u.version !== e.version) return false;
  }
  return true;
}

/**
 * `Journal` over two copies. `load` once, then `append` and `compact`; calls
 * are serialised, so a compaction never interleaves with an append.
 */
export class DualJournal {
  private chain: Promise<unknown> = Promise.resolve();
  /** Highest version ever loaded or appended: the floor for the next compaction. */
  private highest = 0;
  private loaded = false;
  lastReport: DualLoadReport | null = null;

  constructor(private readonly copies: readonly JournalCopy[]) {
    if (copies.length === 0) throw new Error("at least one copy");
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  /** The live entries (highest version per key, deletes removed). */
  load(): Promise<JournalEntry[]> {
    return this.serial(async () => {
      const loads = await Promise.all(this.copies.map((c) => c.load()));
      const healthy = loads.filter((l) => l.state === "ok");
      if (healthy.length === 0 && loads.some((l) => l.state === "corrupt")) {
        // Nothing readable and at least one copy existed: pending writes are lost
        // (journal integrity). Surface it; never silently start empty.
        throw new JournalError("lost", `every journal copy is unreadable (${loads.map((l, i) => `${this.copies[i]!.name}: ${l.state}`).join(", ")})`);
      }
      const union = unionCopies(loads);
      for (const e of union.values()) this.highest = Math.max(this.highest, e.version);
      for (const l of loads) this.highest = Math.max(this.highest, l.floor);
      const live = [...union.values()].filter((e) => e.value !== null);
      const repaired = !loads.every((l) => sameContent(l, union)) && (union.size > 0 || loads.some((l) => l.state !== "missing"));
      if (repaired) await this.compactAll(live);
      this.lastReport = {
        copies: loads.map((l, i) => ({ name: this.copies[i]!.name, state: l.state, entries: l.entries.length, damaged: l.damaged })),
        repaired,
      };
      this.loaded = true;
      return live;
    });
  }

  /** Append a batch; resolves when **both** copies have it durably. */
  append(batch: readonly JournalEntry[]): Promise<void> {
    for (const e of batch) checkEntry(e);
    return this.serial(async () => {
      if (!this.loaded) throw new JournalError("other", "append before load");
      for (const e of batch) {
        if (e.version <= this.highest) throw new JournalError("other", `version ${e.version} not above ${this.highest}`);
      }
      const results = await Promise.allSettled(this.copies.map((c) => c.append(batch)));
      for (const e of batch) this.highest = Math.max(this.highest, e.version);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) {
        const e = failed.reason;
        throw e instanceof JournalError ? e : new JournalError("other", String(e));
      }
    });
  }

  /** Replace both copies' content with `live`. Crash-safe per copy. */
  compact(live: readonly JournalEntry[]): Promise<void> {
    for (const e of live) checkEntry(e);
    return this.serial(() => this.compactAll(live.filter((e) => e.value !== null)));
  }

  private async compactAll(live: readonly JournalEntry[]): Promise<void> {
    const floor = this.highest;
    const results = await Promise.allSettled(this.copies.map((c) => c.compact(live, floor)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason instanceof JournalError ? failed.reason : new JournalError("other", String(failed.reason));
  }
}
