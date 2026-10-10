/**
 * The TS side of `mdbn_store_file::journal` (`crates/store-file/src/journal.rs`).
 *
 * A keyed, versioned, append-only log: each entry sets or deletes one
 * `(space, key)`, and a key's live value is its highest-version entry.
 */

/** One journal entry (mirrors `JournalEntry`). */
export interface JournalEntry {
  /** Namespace (`Space(u8)`). */
  readonly space: number;
  /** Key within the space. */
  readonly key: Uint8Array;
  /**
   * Monotonic per store across all keys (`u64` in Rust). Kept as a JS number:
   * the store assigns versions sequentially, so 2^53 is never reached.
   */
  readonly version: number;
  /** The new value, or `null` to delete the key. */
  readonly value: Uint8Array | null;
}

/** Errors (mirrors `JournalError`). */
export class JournalError extends Error {
  constructor(
    readonly kind: "full" | "lost" | "other",
    message: string,
  ) {
    super(message);
    this.name = "JournalError";
  }
}

/** What one copy of the journal found at load. */
export type CopyState =
  /** Read back intact. */
  | "ok"
  /** Never written, or wiped (eviction, Clear storage, deleted files). */
  | "missing"
  /** Present but unreadable. */
  | "corrupt";

/** One copy's content at load. */
export interface CopyLoad {
  readonly state: CopyState;
  /** Latest entry per key, deletes included (needed for the union). */
  readonly entries: readonly JournalEntry[];
  /**
   * Every version at or below `floor` that this copy does not hold was
   * compacted away (deleted). Zero for a copy that never compacted.
   */
  readonly floor: number;
  /** Lines or records skipped as damaged, for diagnostics. */
  readonly damaged: number;
}

/** One durable copy (IndexedDB, vault file). */
export interface JournalCopy {
  readonly name: string;
  load(): Promise<CopyLoad>;
  /** Durable when the promise resolves. Atomic per batch. */
  append(batch: readonly JournalEntry[]): Promise<void>;
  /** Replace the content with `live`; every version ≤ `floor` not in `live` is gone. Crash-safe. */
  compact(live: readonly JournalEntry[], floor: number): Promise<void>;
}

/** `space:hexkey`, the map key for a journal key. */
export function entryId(space: number, key: Uint8Array): string {
  let s = `${space}:`;
  for (const b of key) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Validate an entry from the store. */
export function checkEntry(e: JournalEntry): void {
  if (!Number.isInteger(e.space) || e.space < 0 || e.space > 255) throw new JournalError("other", `bad space ${e.space}`);
  if (!Number.isSafeInteger(e.version) || e.version < 1) throw new JournalError("other", `bad version ${e.version}`);
}

/** Encode a batch as bytes (used by the vault file). */
export function encodeBatch(batch: readonly JournalEntry[]): Uint8Array {
  let n = 4;
  for (const e of batch) n += 1 + 4 + e.key.length + 8 + 1 + 4 + (e.value?.length ?? 0);
  const out = new Uint8Array(n);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, batch.length);
  o += 4;
  for (const e of batch) {
    out[o++] = e.space;
    dv.setUint32(o, e.key.length);
    o += 4;
    out.set(e.key, o);
    o += e.key.length;
    dv.setBigUint64(o, BigInt(e.version));
    o += 8;
    out[o++] = e.value ? 1 : 0;
    dv.setUint32(o, e.value?.length ?? 0);
    o += 4;
    if (e.value) {
      out.set(e.value, o);
      o += e.value.length;
    }
  }
  return out;
}

/** Decode {@link encodeBatch}; throws on malformed input. */
export function decodeBatch(b: Uint8Array): JournalEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  const need = (k: number) => {
    if (o + k > b.length) throw new Error("truncated batch");
  };
  need(4);
  const count = dv.getUint32(o);
  o += 4;
  const out: JournalEntry[] = [];
  for (let i = 0; i < count; i++) {
    need(5);
    const space = b[o++]!;
    const kl = dv.getUint32(o);
    o += 4;
    need(kl + 13);
    const key = b.slice(o, o + kl);
    o += kl;
    const version = Number(dv.getBigUint64(o));
    o += 8;
    const has = b[o++]!;
    const vl = dv.getUint32(o);
    o += 4;
    need(vl);
    const value = has ? b.slice(o, o + vl) : null;
    o += vl;
    out.push({ space, key, version, value });
  }
  if (o !== b.length) throw new Error("trailing bytes in batch");
  return out;
}
