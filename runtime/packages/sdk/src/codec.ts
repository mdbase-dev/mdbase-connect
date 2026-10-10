/**
 * Typed mapping between TS values and `mdb-cbor/1` items: the TS twin of
 * `crates/wire/src/schema.rs`.
 *
 * Compatibility rules (`00-overview.md` §6.2), as in the Rust macros:
 * - unknown struct keys are ignored on decode;
 * - unknown variants and enum values throw {@link SchemaError} with `unknown: true`
 *   (a client maps that to `upgrade_required`);
 * - absent optional fields are omitted, never encoded as `null`.
 *
 * Friendly forms used by the typed layer:
 * - `uuid` fields are canonical lowercase hyphenated strings;
 * - `hash` fields are `sha256:<64 hex>` strings (the spec's revision token);
 * - integer enums are their snake_case names;
 * - unions carry their variant name in `kind`.
 */
import { CborValue, Float64, fromHex, toHex } from "./cbor.js";

export class SchemaError extends Error {
  constructor(
    readonly ty: string,
    message: string,
    /** An unknown variant or enum value: a newer peer may have produced it. */
    readonly unknown = false,
  ) {
    super(`${ty}: ${message}`);
    this.name = "SchemaError";
  }
}

export interface Codec<T> {
  readonly name: string;
  enc(v: T): CborValue;
  dec(c: CborValue): T;
}

function kindOf(c: CborValue): string {
  if (c === null) return "null";
  if (c instanceof Uint8Array) return "bytes";
  if (c instanceof Float64) return "float";
  if (Array.isArray(c)) return "array";
  if (c instanceof Map) return "map";
  if (typeof c === "number") return Number.isInteger(c) ? "int" : "float";
  return typeof c;
}

function typeErr(ty: string, expected: string, c: CborValue): SchemaError {
  return new SchemaError(ty, `expected ${expected}, found ${kindOf(c)}`);
}

// ------------------------------------------------------------------ primitives

/** Unsigned integer within 2^53 (positions, sizes, counters, IDs). */
export const uint: Codec<number> = {
  name: "uint",
  enc: (v) => {
    if (!Number.isSafeInteger(v) || v < 0) throw new SchemaError("uint", `not an unsigned integer: ${v}`);
    return v;
  },
  dec: (c) => {
    if (typeof c === "number" && Number.isSafeInteger(c) && c >= 0) return c;
    if (typeof c === "bigint" && c >= 0n) throw new SchemaError("uint", "value beyond 2^53 is not supported here");
    throw typeErr("uint", "uint", c);
  },
};

/** Signed integer within ±2^53 (`time-ms`). */
export const int: Codec<number> = {
  name: "int",
  enc: (v) => {
    if (!Number.isSafeInteger(v)) throw new SchemaError("int", `not an integer: ${v}`);
    return v;
  },
  dec: (c) => {
    if (typeof c === "number" && Number.isInteger(c)) return c;
    throw typeErr("int", "int", c);
  },
};

export const tstr: Codec<string> = {
  name: "tstr",
  enc: (v) => {
    if (typeof v !== "string") throw new SchemaError("tstr", "not a string");
    return v;
  },
  dec: (c) => {
    if (typeof c === "string") return c;
    throw typeErr("tstr", "text", c);
  },
};

export const bool: Codec<boolean> = {
  name: "bool",
  enc: (v) => v,
  dec: (c) => {
    if (typeof c === "boolean") return c;
    throw typeErr("bool", "bool", c);
  },
};

export const bytes: Codec<Uint8Array> = {
  name: "bstr",
  enc: (v) => v,
  dec: (c) => {
    if (c instanceof Uint8Array) return c;
    throw typeErr("bstr", "bytes", c);
  },
};

export function fixedBytes(n: number, name: string): Codec<Uint8Array> {
  return {
    name,
    enc: (v) => {
      if (!(v instanceof Uint8Array) || v.length !== n) throw new SchemaError(name, `must be ${n} bytes`);
      return v;
    },
    dec: (c) => {
      if (!(c instanceof Uint8Array)) throw typeErr(name, "bytes", c);
      if (c.length !== n) throw new SchemaError(name, `must be ${n} bytes`);
      return c;
    },
  };
}

export const b16 = fixedBytes(16, "b16");
export const b32 = fixedBytes(32, "b32");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidToBytes(s: string): Uint8Array {
  if (!UUID_RE.test(s)) throw new SchemaError("uuid", `not a UUID: ${s}`);
  return fromHex(s.replace(/-/g, ""));
}

export function uuidFromBytes(b: Uint8Array): string {
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** RFC 9562 UUID: 16 bytes on the wire, canonical lowercase text in TS. */
export const uuid: Codec<string> = {
  name: "uuid",
  enc: (v) => uuidToBytes(v),
  dec: (c) => uuidFromBytes(b16.dec(c)),
};

export function hashToBytes(s: string): Uint8Array {
  const m = /^sha256:([0-9a-f]{64})$/.exec(s);
  if (!m) throw new SchemaError("hash", `not a sha256: revision token: ${s}`);
  return fromHex(m[1]!);
}

export function hashFromBytes(b: Uint8Array): string {
  return `sha256:${toHex(b)}`;
}

/** SHA-256 digest: 32 bytes on the wire, `sha256:<hex>` in TS. */
export const hash: Codec<string> = {
  name: "hash",
  enc: (v) => hashToBytes(v),
  dec: (c) => hashFromBytes(b32.dec(c)),
};

/** `any`: kept as a raw item. */
export const any: Codec<CborValue> = { name: "any", enc: (v) => v, dec: (c) => c };

/** A frontmatter or app value (`value` in CDDL): no byte strings anywhere. */
export const value: Codec<CborValue> = {
  name: "value",
  enc: (v) => {
    checkValue(v);
    return v;
  },
  dec: (c) => {
    checkValue(c);
    return c;
  },
};

function checkValue(c: CborValue, depth = 0): void {
  if (depth > 128) throw new SchemaError("value", "nesting too deep");
  if (c instanceof Uint8Array) throw new SchemaError("value", "byte strings are not values");
  if (typeof c === "bigint") {
    if (c > 0x7fffffffffffffffn || c < -0x8000000000000000n) throw new SchemaError("value", "integer outside int64");
    return;
  }
  if (Array.isArray(c)) {
    for (const x of c) checkValue(x, depth + 1);
  } else if (c instanceof Map) {
    for (const [k, v] of c as Map<unknown, CborValue>) {
      if (typeof k !== "string") throw new SchemaError("value", "map keys must be text");
      checkValue(v, depth + 1);
    }
  }
}

// ------------------------------------------------------------------ combinators

export function list<T>(item: Codec<T>, opts: { nonEmpty?: boolean } = {}): Codec<T[]> {
  const name = `[${item.name}]`;
  return {
    name,
    enc: (v) => {
      if (opts.nonEmpty && v.length === 0) throw new SchemaError(name, "list must not be empty");
      return v.map((x) => item.enc(x));
    },
    dec: (c) => {
      if (!Array.isArray(c)) throw typeErr(name, "array", c);
      if (opts.nonEmpty && c.length === 0) throw new SchemaError(name, "list must not be empty");
      return c.map((x) => item.dec(x));
    },
  };
}

/** A data map: text keys, order significant. */
export function dataMap<T>(item: Codec<T>): Codec<Map<string, T>> {
  const name = `{tstr => ${item.name}}`;
  return {
    name,
    enc: (v) => {
      const m = new Map<string, CborValue>();
      for (const [k, x] of v) m.set(k, item.enc(x));
      return m;
    },
    dec: (c) => {
      if (!(c instanceof Map)) throw typeErr(name, "map", c);
      const m = new Map<string, T>();
      for (const [k, x] of c as Map<unknown, CborValue>) {
        if (typeof k !== "string") throw new SchemaError(name, "data map keys must be text");
        m.set(k, item.dec(x));
      }
      return m;
    },
  };
}

/** Either of two codecs, chosen by a predicate on the TS value and on the item. */
export function either<A, B>(
  name: string,
  a: Codec<A>,
  isA: (v: A | B) => v is A,
  isAItem: (c: CborValue) => boolean,
  b: Codec<B>,
): Codec<A | B> {
  return {
    name,
    enc: (v) => (isA(v) ? a.enc(v) : b.enc(v as B)),
    dec: (c) => (isAItem(c) ? a.dec(c) : b.dec(c)),
  };
}

/** An enumeration encoded as an unsigned integer; TS uses the names. */
export function enumOf<N extends string>(
  name: string,
  names: readonly N[],
  first = 0,
): Codec<N> & { values: readonly N[] } {
  const index = new Map<string, number>(names.map((n, i) => [n, i + first]));
  return {
    name,
    values: names,
    enc: (v) => {
      const i = index.get(v);
      if (i === undefined) throw new SchemaError(name, `unknown value ${JSON.stringify(v)}`);
      return i;
    },
    dec: (c) => {
      if (typeof c === "bigint") throw new SchemaError(name, `unknown variant ${c}`, true);
      if (typeof c !== "number" || !Number.isInteger(c) || c < 0) throw typeErr(name, "uint enum", c);
      const n = c >= first ? names[c - first] : undefined;
      if (n === undefined) throw new SchemaError(name, `unknown variant ${c}`, true);
      return n;
    },
  };
}

export type Mode = "req" | "opt" | "req1" | "opt1";
/** `[key, property, codec, mode]`. Keys must be ascending. */
export type Field = readonly [number, string, Codec<any>, Mode?];

/** A struct map with named fields. Unknown keys are ignored on decode. */
export function struct<T>(name: string, fields: readonly Field[]): Codec<T> {
  for (let i = 1; i < fields.length; i++) {
    if (fields[i]![0] <= fields[i - 1]![0]) throw new Error(`${name}: field keys must ascend`);
  }
  return {
    name,
    enc: (v) => {
      const m = new Map<number, CborValue>();
      const o = v as Record<string, unknown>;
      for (const [key, prop, codec, mode = "req"] of fields) {
        const x = o[prop];
        if (x === undefined) {
          if (mode === "req" || mode === "req1") throw new SchemaError(name, `missing required field ${prop}`);
          continue;
        }
        if ((mode === "req1" || mode === "opt1") && Array.isArray(x) && x.length === 0) {
          throw new SchemaError(name, `${prop} must not be empty`);
        }
        m.set(key, codec.enc(x));
      }
      return m;
    },
    dec: (c) => {
      if (!(c instanceof Map)) throw typeErr(name, "struct map", c);
      const m = c as Map<unknown, CborValue>;
      for (const k of m.keys()) if (typeof k !== "number") throw typeErr(name, "struct map", c);
      const out: Record<string, unknown> = {};
      for (const [key, prop, codec, mode = "req"] of fields) {
        const x = (m as Map<number, CborValue>).get(key);
        if (x === undefined) {
          if (mode === "req" || mode === "req1") throw new SchemaError(name, `missing required key ${key} (${prop})`);
          continue;
        }
        const d = codec.dec(x);
        if ((mode === "req1" || mode === "opt1") && Array.isArray(d) && d.length === 0) {
          throw new SchemaError(name, `${prop} must not be empty`);
        }
        out[prop] = d;
      }
      return out as T;
    },
  };
}

/**
 * A tagged union: the discriminator is key 0 of a struct map; each variant is a
 * struct that does not use key 0. TS values carry the variant name in `kind`.
 */
export function union<T extends { kind: string }>(
  name: string,
  variants: readonly (readonly [number, T["kind"], readonly Field[]])[],
): Codec<T> {
  const byTag = new Map<number, [string, Codec<any>]>();
  const byKind = new Map<string, [number, Codec<any>]>();
  for (const [tag, kind, fields] of variants) {
    const c = struct<any>(`${name}.${kind}`, fields);
    byTag.set(tag, [kind, c]);
    byKind.set(kind, [tag, c]);
  }
  return {
    name,
    enc: (v) => {
      const e = byKind.get(v.kind);
      if (!e) throw new SchemaError(name, `unknown kind ${JSON.stringify(v.kind)}`);
      const inner = e[1].enc(v) as Map<number, CborValue>;
      return new Map<number, CborValue>([[0, e[0]], ...inner]);
    },
    dec: (c) => {
      if (!(c instanceof Map)) throw typeErr(name, "struct map", c);
      const tag = (c as Map<number, CborValue>).get(0);
      if (tag === undefined) throw new SchemaError(name, "missing discriminator");
      if (typeof tag === "bigint") throw new SchemaError(name, `unknown variant ${tag}`, true);
      if (typeof tag !== "number") throw typeErr(name, "uint discriminator", tag);
      const e = byTag.get(tag);
      if (!e) throw new SchemaError(name, `unknown variant ${tag}`, true);
      return { kind: e[0], ...(e[1].dec(c) as object) } as T;
    },
  };
}

/** Wrap a codec with a conversion (for example an array form into an object). */
export function mapped<W, T>(name: string, inner: Codec<W>, to: (w: W) => T, from: (t: T) => W): Codec<T> {
  return { name, enc: (v) => inner.enc(from(v)), dec: (c) => to(inner.dec(c)) };
}

/** A fixed-arity positional array. */
export function tuple<T extends unknown[]>(name: string, items: { [K in keyof T]: Codec<T[K]> }): Codec<T> {
  return {
    name,
    enc: (v) => (items as Codec<unknown>[]).map((c, i) => c.enc(v[i])),
    dec: (c) => {
      if (!Array.isArray(c)) throw typeErr(name, "array", c);
      if (c.length !== items.length) throw new SchemaError(name, "wrong number of elements");
      return (items as Codec<unknown>[]).map((codec, i) => codec.dec(c[i]!)) as T;
    },
  };
}

export function lazy<T>(f: () => Codec<T>): Codec<T> {
  let c: Codec<T> | undefined;
  const get = () => (c ??= f());
  return {
    get name() {
      return get().name;
    },
    enc: (v) => get().enc(v),
    dec: (x) => get().dec(x),
  };
}
