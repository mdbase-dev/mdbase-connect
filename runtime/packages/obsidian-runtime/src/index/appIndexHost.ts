/** Bounded file IndexStorage binary ABI on the first-party app's synchronous index.
 * Matches crates/store-file/src/index_codec.rs; no CBOR/JSON or lossy numbers.
 * This is a trusted same-Worker import, NEVER an app-message/third-party SQL API.
 * Rust keeps ownership of request memory and takes ownership of allocated replies.
 * Every error fences the index; a reply error does not certify rollback. */
import type { AppSqliteIndex } from "./appSqliteIndex.js";
import { IndexError, type Batch, type IndexResultLimits, type SqlValue, type StmtResult } from "./sqliteIndex.js";

const MAGIC = Uint8Array.of(0x4d, 0x44, 0x42, 0x49, 0x44, 0x58, 0, 1);
export const APP_INDEX_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024, maxStatements: 16_384, maxValues: 131_072,
  maxRows: 4096, maxColumns: 100, maxSqlBytes: 100 * 1024, maxParameters: 100,
});
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n, U64_MAX = (1n << 64n) - 1n;
const invalid = () => new IndexError("Other", "invalid app index ABI");
const full = () => new IndexError("Full", "app index ABI budget exceeded");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

class Reader {
  private pos = 0;
  private values = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    if (bytes.length > APP_INDEX_LIMITS.maxBytes) throw full();
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  take(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.bytes.length - this.pos) throw invalid();
    const b = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  byte(): number { return this.take(1)[0]!; }
  u32(): number { const at = this.pos; this.take(4); return this.view.getUint32(at, true); }
  count(max: number, minBytes: number): number {
    const n = this.u32();
    if (n > max) throw full();
    if (n > Math.floor((this.bytes.length - this.pos) / minBytes)) throw invalid();
    return n;
  }
  data(max: number): Uint8Array { return this.take(this.count(max, 1)); }
  text(max: number): string { return utf8.decode(this.data(max)); }
  value(): SqlValue {
    if (++this.values > APP_INDEX_LIMITS.maxValues) throw full();
    switch (this.byte()) {
      case 0: return { kind: "Null" };
      case 1: { const at = this.pos; this.take(8); return { kind: "Integer", value: this.view.getBigInt64(at, true) }; }
      case 2: {
        const at = this.pos; this.take(8);
        const value = this.view.getFloat64(at, true);
        if (!Number.isFinite(value)) throw invalid();
        return { kind: "Real", value };
      }
      case 3: return { kind: "Text", value: this.text(APP_INDEX_LIMITS.maxBytes) };
      case 4: return { kind: "Blob", value: this.data(APP_INDEX_LIMITS.maxBytes).slice() };
      default: throw invalid();
    }
  }
  done(): void { if (this.pos !== this.bytes.length) throw invalid(); }
}

/** Decode the complete envelope before executing any SQL. Reset is deliberately refused. */
function request(bytes: Uint8Array): Batch {
  const r = new Reader(bytes);
  if (!r.take(8).every((b, i) => b === MAGIC[i])) throw invalid();
  const op = r.byte();
  if (op === 1) {
    r.done();
    throw new IndexError("Other", "app database reset requires explicit recovery; automatic wipe refused");
  }
  if (op !== 0) throw invalid();
  const mode = r.byte();
  if (mode > 1) throw invalid();
  const count = r.count(APP_INDEX_LIMITS.maxStatements, 8);
  const stmts: Batch["stmts"][number][] = [];
  for (let i = 0; i < count; i++) {
    const sql = r.text(APP_INDEX_LIMITS.maxSqlBytes);
    const n = r.count(APP_INDEX_LIMITS.maxParameters, 1);
    const params: SqlValue[] = [];
    for (let j = 0; j < n; j++) params.push(r.value());
    stmts.push({ sql, params });
  }
  r.done();
  return { mode: mode === 0 ? "Transaction" : "Autocommit", stmts };
}

class Writer {
  private readonly parts: Uint8Array[] = [];
  private length = 0;
  private values = 0;
  constructor(op: number) { this.put(MAGIC); this.byte(op); }
  private put(b: Uint8Array): void {
    if (b.length > APP_INDEX_LIMITS.maxBytes - this.length) throw full();
    this.length += b.length;
    this.parts.push(b);
  }
  byte(n: number): void { this.put(Uint8Array.of(n)); }
  u32(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw invalid();
    const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); this.put(b);
  }
  int(n: bigint, signed: boolean): void {
    if (typeof n !== "bigint" || n < (signed ? I64_MIN : 0n) || n > (signed ? I64_MAX : U64_MAX)) throw invalid();
    const b = new Uint8Array(8), v = new DataView(b.buffer);
    if (signed) v.setBigInt64(0, n, true); else v.setBigUint64(0, n, true);
    this.put(b);
  }
  data(b: Uint8Array): void { this.u32(b.length); this.put(b); }
  value(v: SqlValue): void {
    if (++this.values > APP_INDEX_LIMITS.maxValues) throw full();
    switch (v.kind) {
      case "Null": this.byte(0); return;
      case "Integer": this.byte(1); this.int(v.value, true); return;
      case "Real": {
        if (!Number.isFinite(v.value)) throw invalid();
        this.byte(2); const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v.value, true); this.put(b); return;
      }
      case "Text": this.byte(3); this.data(encoder.encode(v.value)); return;
      case "Blob": this.byte(4); this.data(v.value); return;
      default: throw invalid();
    }
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) { out.set(part, at); at += part.length; }
    return out;
  }
}

function results(out: StmtResult[], expected: number): Uint8Array {
  if (!Array.isArray(out) || out.length !== expected) throw invalid();
  const w = new Writer(2);
  w.u32(out.length);
  let rows = 0;
  for (const r of out) {
    if (!Number.isSafeInteger(r.columns) || r.columns < 0 || r.columns > APP_INDEX_LIMITS.maxColumns) throw full();
    if (!Array.isArray(r.values) || (r.columns === 0 ? r.values.length !== 0 : r.values.length % r.columns !== 0)) throw invalid();
    rows += r.columns === 0 ? 0 : r.values.length / r.columns;
    if (rows > APP_INDEX_LIMITS.maxRows || r.values.length > APP_INDEX_LIMITS.maxValues) throw full();
    w.u32(r.columns); w.int(r.changes, false); w.int(r.lastInsertRowid, true); w.u32(r.values.length);
    for (const value of r.values) w.value(value);
  }
  return w.done();
}

function errorReply(error: unknown, expected: number | null): Uint8Array {
  const kind = error instanceof IndexError ? error.kind : "Other";
  const tags = { Sql: 0, Corrupt: 1, Full: 2, Busy: 3, Other: 4 };
  const w = new Writer(3);
  w.byte(tags[kind]);
  const stmt = error instanceof IndexError ? error.stmt : null;
  if (expected !== null && stmt !== null && Number.isSafeInteger(stmt) && stmt >= 0 && stmt < expected) {
    w.byte(1); w.u32(stmt);
  } else w.byte(0);
  // Never include backend exception text (which can contain SQL/values or host keys).
  w.data(encoder.encode("app index operation failed; reopen and reconcile"));
  return w.done();
}

/** Holds one generation. Even decode/encode failures fence its clean-shutdown flag. */
export class AppBinaryIndexHost {
  private fenced = false;
  constructor(private readonly index: AppSqliteIndex) {}
  get needsRecovery(): boolean { return this.fenced || this.index.needsRecovery; }
  fence(): void { this.fenced = true; this.index.fence(); }
  run(bytes: Uint8Array): Uint8Array {
    let expected: number | null = null;
    try {
      if (this.needsRecovery) throw invalid();
      const batch = request(bytes);
      expected = batch.stmts.length;
      const limits: IndexResultLimits = APP_INDEX_LIMITS;
      return results(this.index.run(batch, limits), expected);
    } catch (error) {
      this.fence();
      return errorReply(error, expected);
    }
  }
}

export interface AppSqlWasmExports {
  memory: WebAssembly.Memory;
  /** Allocator must not recursively call this import. */
  alloc(length: number): number;
}

function range(memory: WebAssembly.Memory, ptr: number, len: number): void {
  if (!Number.isSafeInteger(ptr) || !Number.isSafeInteger(len) || ptr < 0 || len < 0
    || ptr > 0xffffffff || len > 0xffffffff || ptr > memory.buffer.byteLength || len > memory.buffer.byteLength - ptr) throw invalid();
}

/** Bind after instantiation, then install as the app runtime's SQL import.
 * A bad pointer/allocation throws (fail-stop); never guesses a reply pointer.
 * Request bytes are copied before SQL or alloc, and fresh views follow memory grow. */
export function appSqlHost(host: AppBinaryIndexHost, exports: () => AppSqlWasmExports): (ptr: number, len: number) => bigint {
  let active = false;
  let reentered = false;
  return (ptr, len) => {
    if (active) { reentered = true; host.fence(); throw invalid(); }
    active = true;
    reentered = false;
    try {
      const x = exports();
      range(x.memory, ptr, len);
      if (len > APP_INDEX_LIMITS.maxBytes) { host.fence(); throw full(); }
      const reply = host.run(new Uint8Array(x.memory.buffer, ptr, len).slice());
      const out = x.alloc(reply.length);
      range(x.memory, out, reply.length);
      if (reentered || out === 0 || (out < ptr + len && ptr < out + reply.length)) throw invalid();
      new Uint8Array(x.memory.buffer, out, reply.length).set(reply);
      return (BigInt(out) << 32n) | BigInt(reply.length);
    } catch (error) {
      host.fence();
      throw error;
    } finally { active = false; }
  };
}
