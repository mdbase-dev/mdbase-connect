/**
 * `host_sql`: file's bounded binary index ABI (`mdbn_store_file::index_codec`,
 * file binary index ABI) on the DO's SQLite.
 *
 * Little endian; every message starts `MDBIDX\0\x01` and an operation byte.
 * Requests: 0 Run (mode, statements), 1 Reset. Replies: 2 Results, 3 Error, 4 ResetOk.
 * Values: Null0, Integer1 (i64), Real2 (f64), Text3, Blob4.
 *
 * Numbers: DO bindings and cursors carry JS numbers. Integers outside ±2^53 are
 * refused in both directions. Type evidence: the shared SqlStore schema has no REAL
 * columns and binds no REAL values, so an integral result is INTEGER and any
 * non-integral number (or a REAL parameter) is refused as unexpected.
 *
 * A Run in transaction mode executes inside `transactionSync` (atomic). Results are
 * collected synchronously; nothing is retained across calls. Over the 4 MiB / 4,096
 * row budgets the reply is a typed Full error, never a truncated result.
 */
const MAGIC = [0x4d, 0x44, 0x42, 0x49, 0x44, 0x58, 0x00, 0x01];
const MAX_BYTES = 4 << 20;
const MAX_ROWS = 4096;
const MAX_PARAMS = 100;
const MAX_SQL = 100 << 10;
const MAX_STATEMENTS = 16_384;
const MAX_VALUES = 131_072;
const MAX_COLUMNS = 100;

type Ex = { memory: WebAssembly.Memory; alloc(n: number): number };
type Val = null | number | string | ArrayBuffer;

class Fail extends Error {
  constructor(readonly kind: number, msg: string, readonly stmt?: number) {
    super(msg);
  }
}
const SQL = 0, FULL = 2, OTHER = 4;

class Reader {
  private off = 0;
  private view: DataView;
  constructor(private b: Uint8Array) {
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  need(n: number) {
    if (this.off + n > this.b.length) throw new Fail(OTHER, "truncated request");
  }
  u8() { this.need(1); return this.b[this.off++]!; }
  u32() { this.need(4); const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  i64() { this.need(8); const v = this.view.getBigInt64(this.off, true); this.off += 8; return v; }
  bytes(n: number) { this.need(n); const v = this.b.subarray(this.off, this.off + n); this.off += n; return v; }
  str(max: number) {
    const n = this.u32();
    if (n > max) throw new Fail(FULL, "string over budget");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.bytes(n));
  }
  end() { if (this.off !== this.b.length) throw new Fail(OTHER, "trailing bytes"); }
}

/** Bytes and values are budgeted across a whole reply (shared by sub-writers). */
class Budget {
  bytes = 0;
  values = 0;
}

class Writer {
  private parts: Uint8Array[] = [];
  private len = 0;
  constructor(readonly budget: Budget = new Budget()) {}
  private push(b: Uint8Array) {
    this.len += b.length;
    this.budget.bytes += b.length;
    if (this.budget.bytes > MAX_BYTES) throw new Fail(FULL, "reply over budget");
    this.parts.push(b);
  }
  append(w: Writer) {
    for (const p of w.parts) this.parts.push(p);
    this.len += w.len;
  }
  u8(v: number) { this.push(Uint8Array.of(v)); }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.push(b); }
  u64(v: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); this.push(b); }
  i64(v: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v, true); this.push(b); }
  bytes(b: Uint8Array) { this.u32(b.length); this.push(b); }
  value(v: Val) {
    if (v === null) return this.u8(0);
    if (typeof v === "number") {
      if (!Number.isInteger(v)) throw new Fail(SQL, "unexpected REAL result");
      if (!Number.isSafeInteger(v)) throw new Fail(SQL, "integer beyond 2^53");
      this.u8(1);
      return this.i64(BigInt(v));
    }
    if (typeof v === "string") { this.u8(3); return this.bytes(new TextEncoder().encode(v)); }
    this.u8(4);
    this.bytes(new Uint8Array(v));
  }
  done() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

function readValue(r: Reader): Val {
  switch (r.u8()) {
    case 0: return null;
    case 1: {
      const v = r.i64();
      if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new Fail(SQL, "integer beyond 2^53");
      return Number(v);
    }
    case 2: throw new Fail(SQL, "unexpected REAL parameter");
    case 3: return r.str(MAX_BYTES);
    case 4: return r.bytes(r.u32()).slice().buffer;
    default: throw new Fail(OTHER, "unknown value tag");
  }
}

function header(w: Writer, op: number) {
  for (const b of MAGIC) w.u8(b);
  w.u8(op);
}

function error(e: unknown): Uint8Array {
  const w = new Writer();
  header(w, 3);
  const f = e instanceof Fail ? e : new Fail(/SQLITE_FULL|storage limit|exceeded/i.test(String(e)) ? FULL : SQL, String(e));
  w.u8(f.kind);
  if (f.stmt === undefined) w.u8(0);
  else { w.u8(1); w.u32(f.stmt); }
  w.bytes(new TextEncoder().encode(f.message.slice(0, 512)));
  return w.done();
}

export function runIndex(storage: DurableObjectStorage, request: Uint8Array): Uint8Array {
  try {
    if (request.length > MAX_BYTES) throw new Fail(FULL, "request over budget");
    const r = new Reader(request);
    for (const b of MAGIC) if (r.u8() !== b) throw new Fail(OTHER, "bad magic or version");
    const op = r.u8();
    if (op === 1) {
      r.end();
      const names = storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'st\\_%' ESCAPE '\\'")
        .toArray()
        .map((x) => x.name)
        .filter((n) => /^st_[A-Za-z0-9_]+$/.test(n));
      storage.transactionSync(() => {
        for (const n of names) storage.sql.exec(`DROP TABLE IF EXISTS "${n}"`);
      });
      const w = new Writer();
      header(w, 4);
      return w.done();
    }
    if (op !== 0) throw new Fail(OTHER, "unknown operation");
    const mode = r.u8();
    if (mode > 1) throw new Fail(OTHER, "unknown mode");
    const count = r.u32();
    if (count > MAX_STATEMENTS) throw new Fail(FULL, "too many statements");
    let paramValues = 0;
    const stmts: { sql: string; params: Val[] }[] = [];
    for (let i = 0; i < count; i++) {
      const sql = r.str(MAX_SQL);
      const n = r.u32();
      if (n > MAX_PARAMS) throw new Fail(FULL, "too many parameters", i);
      if ((paramValues += n) > MAX_VALUES) throw new Fail(FULL, "too many values", i);
      const params: Val[] = [];
      for (let j = 0; j < n; j++) params.push(readValue(r));
      stmts.push({ sql, params });
    }
    r.end();
    // Validated in full before any SQL runs.
    const w = new Writer();
    header(w, 2);
    w.u32(stmts.length);
    let rows = 0;
    const run = () => {
      stmts.forEach((s, i) => {
        let cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
        try {
          cursor = storage.sql.exec(s.sql, ...s.params);
        } catch (e) {
          throw new Fail(SQL, String(e), i);
        }
        const columns = cursor.columnNames.length;
        if (columns > MAX_COLUMNS) throw new Fail(FULL, "too many columns", i);
        // Encode while iterating: the shared budget stops a large result long
        // before it is materialized.
        const vals = new Writer(w.budget);
        let count = 0;
        for (const row of cursor.raw()) {
          if (++rows > MAX_ROWS) throw new Fail(FULL, "rows over budget", i);
          for (const v of row) {
            if (++w.budget.values > MAX_VALUES) throw new Fail(FULL, "too many values", i);
            vals.value(v as Val);
            count++;
          }
        }
        const info = storage.sql.exec<{ c: number; r: number }>("SELECT changes() c, last_insert_rowid() r").one();
        if (!Number.isSafeInteger(info.c) || info.c < 0 || !Number.isSafeInteger(info.r)) {
          throw new Fail(OTHER, "unsafe changes/rowid", i);
        }
        w.u32(columns);
        w.u64(BigInt(info.c));
        w.i64(BigInt(info.r));
        w.u32(count);
        w.append(vals);
      });
    };
    if (mode === 0) storage.transactionSync(run);
    else run();
    return w.done();
  } catch (e) {
    return error(e);
  }
}

export function sqlHost(storage: DurableObjectStorage, ex: () => Ex) {
  return (p: number, n: number): bigint => {
    // Copy out before running SQL: Wasm memory can grow under us later.
    const reply = n > MAX_BYTES ? error(new Fail(FULL, "request over budget"))
      : runIndex(storage, new Uint8Array(ex().memory.buffer, p, n).slice());
    const ptr = ex().alloc(reply.length);
    new Uint8Array(ex().memory.buffer, ptr, reply.length).set(reply);
    return (BigInt(ptr) << 32n) | BigInt(reply.length);
  };
}
