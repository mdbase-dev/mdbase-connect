/**
 * Contract-scoped records for `MemoryReplica`: a declared subset of Core's
 * implementation mapping (contract field → record field), so apps can test
 * contract flows. It does not parse contract or type files and does not validate
 * the mapped view against the contract schema.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import type { CborValue } from "../cbor.js";
import { hashFromBytes } from "../codec.js";
import { mdbaseError } from "../errors.js";
import type * as w from "../wire.js";

/** One type implementing one contract version, as Core's catalog would see it. */
export interface MemoryContract {
  id: string;
  version: string;
  /** The implementing type. Records carry it in `types`. */
  type: string;
  /** Contract field → record field: a top-level key, or a JSON pointer (`/meta/label`). */
  fields: Record<string, string>;
  /** Digests to report (`sha256:<hex>`); default: a stand-in hash of `id@version` (and `:type`). */
  contractDigest?: string;
  implementationDigest?: string;
}

type Rec = { types: string[]; frontmatter: w.FmMap };

const digestOf = (s: string) => hashFromBytes(sha256(new TextEncoder().encode(s)));
export const contractDigest = (c: { id: string; version: string; contractDigest?: string }) =>
  c.contractDigest ?? digestOf(`${c.id}@${c.version}`);
export const implementationDigest = (c: MemoryContract) => c.implementationDigest ?? digestOf(`${c.id}@${c.version}:${c.type}`);

function steps(ref: string): string[] {
  if (!ref.startsWith("/")) return [ref];
  return ref.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function read(fm: w.FmMap, ref: string): CborValue | undefined {
  let v: CborValue | undefined = fm.get(steps(ref)[0]!);
  for (const step of steps(ref).slice(1)) {
    if (v instanceof Map) v = (v as Map<string, CborValue>).get(step);
    else if (Array.isArray(v) && /^\d+$/.test(step)) v = v[Number(step)];
    else return undefined;
  }
  return v;
}

function clone(v: CborValue | undefined): CborValue {
  if (v instanceof Map) return new Map([...(v as Map<string, CborValue>)].map(([k, x]) => [k, clone(x)]));
  if (Array.isArray(v)) return v.map(clone);
  return v === undefined ? new Map() : v;
}

/** Set (or delete, `value === undefined`) a nested step inside a top-level value. */
function write(top: CborValue, path: string[], value: CborValue | undefined): CborValue {
  const root = clone(top);
  let node = root;
  for (const [i, step] of path.entries()) {
    const last = i === path.length - 1;
    if (Array.isArray(node) && /^\d+$/.test(step)) {
      const at = Number(step);
      if (last && value === undefined) node.splice(at, 1);
      else if (last) node[at] = value!;
      else node = node[at] ?? (node[at] = new Map());
    } else if (node instanceof Map) {
      const m = node as Map<string, CborValue>;
      if (last && value === undefined) m.delete(step);
      else if (last) m.set(step, value!);
      else {
        if (!(m.get(step) instanceof Map) && !Array.isArray(m.get(step))) m.set(step, new Map());
        node = m.get(step)!;
      }
    } else {
      throw mdbaseError("invalid_request", "a mapped record field is not an object", "data_contract_field_conflict");
    }
  }
  return root;
}

/** The implementation a selection names, for a record (or for a create). */
export function implementationFor(
  all: readonly MemoryContract[],
  sel: { id: string; version: string; type?: string },
  record?: Rec,
): MemoryContract {
  const of = all.filter((c) => c.id === sel.id && c.version === sel.version);
  if (!of.length) throw mdbaseError("not_found", "no such contract", "data_contract_not_found");
  const pick = of.filter((c) => (sel.type === undefined || c.type === sel.type) && (!record || record.types.includes(c.type)));
  if (!pick.length) throw mdbaseError("not_found", "the record does not implement the contract", "data_contract_not_implemented");
  if (pick.length > 1) {
    throw mdbaseError("invalid_request", "several types implement the contract; select one", {
      reason: "data_contract_ambiguous",
      details: pick.map((c) => c.type),
    });
  }
  return pick[0]!;
}

/** A record's contract fields. */
export function contractFields(c: MemoryContract, r: Rec): w.FmMap {
  const out = new Map<string, CborValue>();
  for (const [cf, rf] of Object.entries(c.fields)) {
    const v = read(r.frontmatter, rf);
    if (v !== undefined) out.set(cf, v);
  }
  return out;
}

/** Contract field changes as top-level record changes. Nested record fields are
 * merged with the current value, which is sent as `base`. */
export function mapWrite(
  c: MemoryContract,
  record: Rec | undefined,
  fields: Map<string, CborValue>,
  unset: readonly string[],
): { patch: w.FmMap; unset: string[]; base: w.BaseField[] } {
  const patch = new Map<string, CborValue>();
  const drop: string[] = [];
  const base = new Map<string, w.BaseField>();
  const changes: [string, CborValue | undefined][] = [...fields, ...unset.map((k) => [k, undefined] as [string, undefined])];
  for (const [cf, value] of changes) {
    const rf = c.fields[cf];
    if (rf === undefined) {
      throw mdbaseError("invalid_request", `\`${cf}\` is not a field of the contract`, { reason: "data_contract_field_unmapped", details: cf });
    }
    const [top, ...rest] = steps(rf);
    if (!rest.length) {
      if (value === undefined) drop.push(top!);
      else patch.set(top!, value);
      continue;
    }
    if (drop.includes(top!)) throw mdbaseError("invalid_request", "conflicting contract field changes", "data_contract_field_conflict");
    const current = patch.has(top!) ? patch.get(top!) : record?.frontmatter.get(top!);
    if (!base.has(top!)) {
      const observed = record?.frontmatter.get(top!);
      base.set(top!, observed === undefined ? { key: top! } : { key: top!, observed });
    }
    patch.set(top!, write(current as CborValue, rest, value));
  }
  return { patch, unset: drop, base: [...base.values()] };
}
