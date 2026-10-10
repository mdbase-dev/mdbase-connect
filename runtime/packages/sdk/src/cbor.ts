/**
 * The `mdb-cbor/1` profile: a strict, deterministic subset of CBOR (RFC 8949).
 *
 * Normative text: `docs/contracts/00-overview.md` §3.2. This is the TS twin of
 * `crates/wire/src/cbor.rs` and enforces the same nine rules on encode and decode.
 *
 * JS value model (replica-client-api.md §12.1):
 * - integers are `number` when within ±(2^53 − 1), otherwise `bigint`;
 * - floats are `number` when not integral, otherwise a {@link Float64} wrapper, so that
 *   `1` and `1.0` survive the round trip;
 * - byte strings are `Uint8Array`;
 * - data maps (text keys) are `Map<string, CborValue>`, insertion order is data;
 * - struct maps (unsigned integer keys) are `Map<number, CborValue>`.
 */

/** A float whose value is integral (or −0), kept distinct from an integer. */
export class Float64 {
  constructor(readonly value: number) {}
  valueOf(): number {
    return this.value;
  }
  toJSON(): number {
    return this.value;
  }
}

export type CborMap = Map<string, CborValue> | Map<number, CborValue>;
export type CborValue =
  | null
  | boolean
  | number
  | bigint
  | Float64
  | string
  | Uint8Array
  | CborValue[]
  | CborMap;

/** Maximum nesting depth, as in the Rust codec. */
export const MAX_DEPTH = 128;

export type CborErrorKind =
  | "unexpected_end"
  | "trailing_bytes"
  | "indefinite"
  | "non_canonical_head"
  | "tag"
  | "float"
  | "simple"
  | "utf8"
  | "mixed_map_keys"
  | "unsorted_keys"
  | "duplicate_key"
  | "too_deep"
  | "too_long"
  | "unencodable";

/** Bytes that are not valid `mdb-cbor/1`, or a value that cannot be encoded. */
export class CborError extends Error {
  constructor(
    readonly kind: CborErrorKind,
    message?: string,
  ) {
    super(message ?? kind);
    this.name = "CborError";
  }
}

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// ------------------------------------------------------------------ encoding

class Writer {
  buf = new Uint8Array(256);
  len = 0;
  private view = new DataView(this.buf.buffer);

  constructor(private readonly sensitive = false) {}

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    if (this.sensitive) this.buf.fill(0);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  head(major: number, arg: number | bigint): void {
    const m = major << 5;
    if (typeof arg === "number" && arg < 24) {
      this.byte(m | arg);
    } else if (typeof arg === "number" && arg <= 0xff) {
      this.ensure(2);
      this.buf[this.len++] = m | 24;
      this.buf[this.len++] = arg;
    } else if (typeof arg === "number" && arg <= 0xffff) {
      this.ensure(3);
      this.buf[this.len++] = m | 25;
      this.view.setUint16(this.len, arg);
      this.len += 2;
    } else if (typeof arg === "number" && arg <= 0xffffffff) {
      this.ensure(5);
      this.buf[this.len++] = m | 26;
      this.view.setUint32(this.len, arg);
      this.len += 4;
    } else {
      const big = BigInt(arg);
      if (big <= 0xffffffffn) return this.head(major, Number(big));
      this.ensure(9);
      this.buf[this.len++] = m | 27;
      this.view.setBigUint64(this.len, big);
      this.len += 8;
    }
  }

  float(f: number): void {
    if (!Number.isFinite(f)) throw new CborError("float", "float must be finite");
    this.ensure(9);
    this.buf[this.len++] = 0xfb;
    this.view.setFloat64(this.len, f);
    this.len += 8;
  }

  wipeTemporary(bytes: Uint8Array): void {
    if (this.sensitive) bytes.fill(0);
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function isWellFormed(s: string): boolean {
  const f = (s as { isWellFormed?: () => boolean }).isWellFormed;
  if (f) return f.call(s);
  // Fallback: reject lone surrogates.
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function encodeInt(w: Writer, v: number | bigint): void {
  const big = typeof v === "bigint" ? v : BigInt(v);
  if (big >= 0n) {
    if (big > U64_MAX) throw new CborError("unencodable", "integer above 2^64-1");
    w.head(0, typeof v === "number" ? v : big);
  } else {
    if (big < I64_MIN) throw new CborError("unencodable", "integer below -2^63");
    const n = -1n - big;
    w.head(1, n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n);
  }
}

function encodeMap(w: Writer, m: CborMap, depth: number): void {
  const entries = [...m.entries()] as [string | number, CborValue][];
  checkMapKeys(entries.map(([k]) => k));
  w.head(5, entries.length);
  for (const [k, v] of entries) {
    if (typeof k === "number") w.head(0, k);
    else encodeText(w, k);
    encodeInto(w, v, depth + 1);
  }
}

function encodeText(w: Writer, s: string): void {
  if (!isWellFormed(s)) throw new CborError("utf8", "text is not well-formed UTF-16");
  const b = textEncoder.encode(s);
  try {
    w.head(3, b.length);
    w.bytes(b);
  } finally {
    w.wipeTemporary(b);
  }
}

function checkMapKeys(keys: (string | number | bigint)[]): void {
  if (keys.length === 0) return;
  if (typeof keys[0] === "string") {
    const seen = new Set<string>();
    for (const k of keys) {
      if (typeof k !== "string") throw new CborError("mixed_map_keys");
      if (seen.has(k)) throw new CborError("duplicate_key", `duplicate data map key ${JSON.stringify(k)}`);
      seen.add(k);
    }
    return;
  }
  let prev: bigint | undefined;
  for (const k of keys) {
    if (typeof k === "string") throw new CborError("mixed_map_keys");
    if (typeof k === "number" && !(Number.isSafeInteger(k) && k >= 0)) {
      throw new CborError("mixed_map_keys", "struct map keys must be unsigned integers");
    }
    const b = BigInt(k);
    if (b < 0n) throw new CborError("mixed_map_keys");
    if (prev !== undefined && prev >= b) throw new CborError("unsorted_keys");
    prev = b;
  }
}

function encodeInto(w: Writer, v: CborValue, depth: number): void {
  if (depth > MAX_DEPTH) throw new CborError("too_deep");
  if (v === null) return w.byte(0xf6);
  switch (typeof v) {
    case "boolean":
      return w.byte(v ? 0xf5 : 0xf4);
    case "number":
      if (Number.isSafeInteger(v) && !Object.is(v, -0)) return encodeInt(w, v);
      return w.float(v);
    case "bigint":
      return encodeInt(w, v);
    case "string":
      return encodeText(w, v);
  }
  if (v instanceof Float64) return w.float(v.value);
  if (v instanceof Uint8Array) {
    w.head(2, v.length);
    return w.bytes(v);
  }
  if (Array.isArray(v)) {
    w.head(4, v.length);
    for (const item of v) encodeInto(w, item, depth + 1);
    return;
  }
  if (v instanceof Map) return encodeMap(w, v, depth);
  throw new CborError("unencodable", `cannot encode ${Object.prototype.toString.call(v)}`);
}

/** Encode a value in canonical `mdb-cbor/1` form. */
export function encode(v: CborValue): Uint8Array {
  const w = new Writer();
  encodeInto(w, v, 0);
  return w.result();
}

/**
 * Encode key-bearing values, wiping all encoder-owned scratch buffers (including
 * superseded growth buffers) on return or throw. The caller owns the result and
 * must wipe it after use; source byte strings remain caller-owned and untouched.
 * Source JS strings are immutable and cannot be erased: use byte arrays for keys.
 */
export function encodeSecret(v: CborValue): Uint8Array {
  const w = new Writer(true);
  try {
    encodeInto(w, v, 0);
    return w.result();
  } finally {
    w.buf.fill(0);
  }
}

// ------------------------------------------------------------------ decoding

class Reader {
  pos = 0;
  private view: DataView;
  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  need(n: number): void {
    if (n > this.remaining) throw new CborError("unexpected_end");
  }

  byte(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  take(n: number): Uint8Array {
    this.need(n);
    const s = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  /** The argument of a head with additional info `ai`, shortest form enforced. */
  arg(ai: number): number | bigint {
    if (ai < 24) return ai;
    switch (ai) {
      case 24: {
        const v = this.byte();
        if (v < 24) throw new CborError("non_canonical_head");
        return v;
      }
      case 25: {
        this.need(2);
        const v = this.view.getUint16(this.pos);
        this.pos += 2;
        if (v <= 0xff) throw new CborError("non_canonical_head");
        return v;
      }
      case 26: {
        this.need(4);
        const v = this.view.getUint32(this.pos);
        this.pos += 4;
        if (v <= 0xffff) throw new CborError("non_canonical_head");
        return v;
      }
      case 27: {
        this.need(8);
        const v = this.view.getBigUint64(this.pos);
        this.pos += 8;
        if (v <= 0xffffffffn) throw new CborError("non_canonical_head");
        return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      }
      case 31:
        throw new CborError("indefinite");
      default:
        throw new CborError("non_canonical_head", "reserved additional info");
    }
  }

  len(ai: number): number {
    const n = this.arg(ai);
    if (typeof n === "bigint") throw new CborError("too_long");
    // Every element needs at least one byte.
    if (n > this.remaining) throw new CborError("unexpected_end");
    return n;
  }

  item(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new CborError("too_deep");
    const ib = this.byte();
    const major = ib >> 5;
    const ai = ib & 0x1f;
    switch (major) {
      case 0:
        return this.arg(ai);
      case 1: {
        const n = this.arg(ai);
        if (typeof n === "number") {
          const v = -1 - n;
          return Number.isSafeInteger(v) ? v : -1n - BigInt(n);
        }
        return -1n - n;
      }
      case 2:
        return this.take(this.len(ai)).slice();
      case 3: {
        const b = this.take(this.len(ai));
        try {
          return textDecoder.decode(b);
        } catch {
          throw new CborError("utf8");
        }
      }
      case 4: {
        const n = this.len(ai);
        const out: CborValue[] = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.item(depth + 1);
        return out;
      }
      case 5: {
        const n = this.len(ai);
        const keys: (string | number | bigint)[] = [];
        const vals: CborValue[] = [];
        for (let i = 0; i < n; i++) {
          const k = this.item(depth + 1);
          if (typeof k !== "string" && typeof k !== "number" && typeof k !== "bigint") {
            throw new CborError("mixed_map_keys");
          }
          if ((typeof k === "number" || typeof k === "bigint") && k < 0) {
            throw new CborError("mixed_map_keys");
          }
          keys.push(k);
          vals.push(this.item(depth + 1));
        }
        checkMapKeys(keys);
        const m = new Map<string | number, CborValue>();
        for (let i = 0; i < n; i++) {
          const k = keys[i]!;
          if (typeof k === "bigint") throw new CborError("too_long", "struct key beyond 2^53");
          m.set(k, vals[i]!);
        }
        return m as CborMap;
      }
      case 6:
        throw new CborError("tag");
      default:
        switch (ai) {
          case 20:
            return false;
          case 21:
            return true;
          case 22:
            return null;
          case 27: {
            this.need(8);
            const f = this.view.getFloat64(this.pos);
            this.pos += 8;
            if (!Number.isFinite(f)) throw new CborError("float");
            return Number.isInteger(f) ? new Float64(f) : f;
          }
          case 25:
          case 26:
            throw new CborError("float", "float must be binary64");
          case 31:
            throw new CborError("indefinite");
          default:
            throw new CborError("simple");
        }
    }
  }
}

/** Decode exactly one canonical `mdb-cbor/1` item. Any profile violation throws. */
export function decode(bytes: Uint8Array): CborValue {
  const r = new Reader(bytes);
  const v = r.item(0);
  if (r.remaining !== 0) throw new CborError("trailing_bytes");
  return v;
}

/** True when `bytes` is valid `mdb-cbor/1`. */
export function isValid(bytes: Uint8Array): boolean {
  try {
    decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ helpers

/** A struct map from `[key, value]` pairs, dropping `undefined` values. */
export function structMap(entries: [number, CborValue | undefined][]): Map<number, CborValue> {
  const m = new Map<number, CborValue>();
  for (const [k, v] of entries) if (v !== undefined) m.set(k, v);
  return m;
}

/** Lowercase hex. */
export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Parse lowercase or uppercase hex. */
export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Byte-wise equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
