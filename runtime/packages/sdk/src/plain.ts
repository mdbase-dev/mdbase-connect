/**
 * Plain JSON answers. The wire codecs decode exactly: data maps as `Map` in
 * their order, floats as `Float64`, big integers as `bigint`. An app reads
 * records as JSON, so the client decodes every answer with `decodePlain`
 * (`codec.ts`), which yields plain data wherever the schema says "value".
 * The exact form stays in the `wire` codecs.
 */
import { Float64, toHex, type CborValue } from "./cbor.js";
import type * as w from "./wire.js";

/** A JSON value: what the client hands an app wherever a record holds data. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** A JSON object, such as a record's frontmatter. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * `T` as the client hands it to an app: every data map is an object, every
 * value is JSON. Three things are given up, as for any JSON reading of YAML:
 * `1.0` reads as `1`, an integer beyond 2^53 reads as a decimal string, and
 * keys that look like integers come first in an object.
 */
export type Plain<T> =
  [T] extends [JsonValue | undefined] ? T
  : [CborValue] extends [T] ? JsonValue
  : T extends Uint8Array ? T
  : T extends ReadonlyMap<string, infer V> ? { [key: string]: Plain<V> }
  : T extends object ? { [K in keyof T]: Plain<T[K]> }
  : T;

/**
 * A plain-object view of an exact value. Integral floats become numbers; big
 * integers become strings. Key order of integer-like keys follows JS object
 * rules; use the `Map` for exact order.
 */
export function toPlain(v: CborValue): JsonValue {
  if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Float64) return v.value;
  if (v instanceof Uint8Array) return toHex(v);
  if (Array.isArray(v)) return v.map(toPlain);
  // Own properties whatever the key: `__proto__` is a field, not a prototype.
  return Object.fromEntries([...(v as Map<string | number, CborValue>)].map(([k, x]) => [String(k), toPlain(x)]));
}

/** @internal One field a JSON object itself holds; undefined for anything else. */
export function fieldOf(value: unknown, key: string): JsonValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as JsonObject)[key]
    : undefined;
}

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

// What the client hands an app, named as on the wire. Each is `Plain` of the
// wire type. The interface, and the named field where one holds another of
// these, only keeps the name in editor hovers and compiler errors;
// `test/plain-values.test.ts` fails to compile if a named field drifts from the
// wire type. A type that carries no values is the same in both forms and is
// exported from `wire` alone.
export type ConflictValue = Plain<w.ConflictValue>;
export interface RecordView extends Plain<w.RecordView> {}
export interface Conflict extends Omit<Plain<w.Conflict>, "base" | "kept" | "lost"> { base?: ConflictValue; kept: ConflictValue; lost: ConflictValue }
export interface ConflictEntry extends Omit<Plain<w.ConflictEntry>, "conflict"> { conflict: Conflict }
export interface Receipt extends Omit<Plain<w.Receipt>, "records" | "conflicts"> { conflicts?: Conflict[]; records?: RecordView[] }
export interface PendingMutation extends Omit<Plain<w.PendingMutation>, "receipt"> { receipt: Receipt }
export interface QueryGroup extends Plain<w.QueryGroup> {}
export interface QueryMetadata extends Omit<Plain<w.QueryMetadata>, "groups"> { groups?: QueryGroup[] }
export interface QueryResult extends Omit<Plain<w.QueryResult>, "records" | "groups"> { records: RecordView[]; groups?: QueryGroup[] }
export interface QueryUpdate extends Omit<Plain<w.QueryUpdate>, "added" | "changed" | "metadata"> { added?: RecordView[]; changed?: RecordView[]; metadata?: QueryMetadata }
export interface Backlink extends Omit<Plain<w.Backlink>, "record"> { record: RecordView }
export interface BacklinksResult extends Omit<Plain<w.BacklinksResult>, "backlinks"> { backlinks: Backlink[] }
export interface ContractImplementation extends Plain<w.ContractImplementation> {}
export interface ContractSummary extends Plain<w.ContractSummary> {}
export interface TypeSummary extends Omit<Plain<w.TypeSummary>, "implements"> { implements: ContractImplementation[] }
export interface DescribeResult extends Omit<Plain<w.DescribeResult>, "types" | "contracts"> { types: TypeSummary[]; contracts: ContractSummary[] }
export interface Peer extends Plain<w.Peer> {}
export interface ViewDescriptor extends Plain<w.ViewDescriptor> {}
export interface ViewSource extends Omit<Plain<w.ViewSource>, "views"> { views: ViewDescriptor[] }
