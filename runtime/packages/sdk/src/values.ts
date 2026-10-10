/**
 * Helpers between app-friendly JS values and the exact value model.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { CborValue, Float64, toHex } from "./cbor.js";
import { uuidFromBytes } from "./codec.js";

/** Plain JSON-ish data an app may pass where a `value` is expected. */
export type PlainValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Float64
  | PlainValue[]
  | Map<string, PlainValue>
  | { [key: string]: PlainValue | undefined };

/**
 * Convert plain data into a `value`: objects become data maps in property order.
 * Note: JS puts integer-like keys ("2024") first in objects. Pass a `Map` when such
 * keys must keep their order.
 */
export function toValue(v: PlainValue | undefined): CborValue {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") return v;
  if (v instanceof Float64) return v;
  if (Array.isArray(v)) return v.map(toValue);
  if (v instanceof Map) {
    const m = new Map<string, CborValue>();
    for (const [k, x] of v) m.set(k, toValue(x));
    return m;
  }
  if (v instanceof Date) return v.toISOString();
  const m = new Map<string, CborValue>();
  for (const [k, x] of Object.entries(v)) if (x !== undefined) m.set(k, toValue(x));
  return m;
}

export function toFmMap(v: Map<string, PlainValue> | { [k: string]: PlainValue | undefined }): Map<string, CborValue> {
  return toValue(v) as Map<string, CborValue>;
}

export type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

/**
 * A plain-object view of a value, for display and for code written against JSON.
 * Integral floats become numbers; big integers become strings. Key order of
 * integer-like keys follows JS object rules; use the `Map` for exact order.
 */
export function toPlain(v: CborValue): JsonLike {
  if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Float64) return v.value;
  if (v instanceof Uint8Array) return toHex(v);
  if (Array.isArray(v)) return v.map(toPlain);
  const o: { [k: string]: JsonLike } = {};
  for (const [k, x] of v as Map<string | number, CborValue>) o[String(k)] = toPlain(x);
  return o;
}

/** Spec 12A-style equality of two values (exact: ints and floats differ). */
export function valueEquals(a: CborValue, b: CborValue): boolean {
  if (a === b) return true;
  if (a instanceof Float64 && b instanceof Float64) return Object.is(a.value, b.value) || a.value === b.value;
  if (typeof a === "bigint" || typeof b === "bigint") return BigInt(a as bigint) === BigInt(b as bigint);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => valueEquals(x, b[i]!));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    const ea = [...(a as Map<unknown, CborValue>)];
    const eb = [...(b as Map<unknown, CborValue>)];
    return ea.every(([k, x], i) => eb[i]![0] === k && valueEquals(x, eb[i]![1]));
  }
  return false;
}

/** `sha256:<hex>` of a string's UTF-8 bytes: a body or document revision. */
export function revisionOf(text: string | Uint8Array): string {
  const b = typeof text === "string" ? new TextEncoder().encode(text) : text;
  return `sha256:${toHex(sha256(b))}`;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

let lastMs = 0;
let lastSeq = 0;

/**
 * A new UUIDv7 (RFC 9562): 48-bit Unix milliseconds, then random bits. IDs minted in
 * the same millisecond by this process stay ordered.
 */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  if (now <= lastMs) {
    now = lastMs;
    lastSeq = (lastSeq + 1) & 0xfff;
    if (lastSeq === 0) now = ++lastMs;
  } else {
    lastSeq = ((b[6]! & 0x0f) << 8) | b[7]!;
    lastSeq &= 0x7ff; // leave room to count up within a millisecond
  }
  lastMs = now;
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = 0x70 | ((lastSeq >> 8) & 0x0f);
  b[7] = lastSeq & 0xff;
  b[8] = 0x80 | (b[8]! & 0x3f);
  return uuidFromBytes(b);
}

/**
 * The smallest single edit turning `base` into `next`, in Unicode scalar offsets of
 * `base` (the `body_edits` unit). Returns no edits when they are equal.
 */
export function diffEdits(base: string, next: string): [number, number, string][] {
  if (base === next) return [];
  const a = Array.from(base);
  const b = Array.from(next);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return [[pre, a.length - suf, b.slice(pre, b.length - suf).join("")]];
}
