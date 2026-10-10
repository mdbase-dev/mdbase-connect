import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decode, encode, type CborValue, toHex } from "../src/cbor.js";
import { attachmentContentV1, attachmentRefV1, runtimeMutation, runtimeOp } from "../src/runtime-wire.js";
import { mutation, op } from "../src/wire.js";
import { SchemaError, union, uuid, tstr, hash } from "../src/codec.js";
import type { FileAttach } from "../src/runtime-wire.js";

const root = join(import.meta.dirname, "../../../conformance/wire/mutation");
const fixture = () => new Uint8Array(readFileSync(join(root, "runtime-v1-mixed.cbor")));
function attach(): Map<number, CborValue> {
  const m = decode(fixture()) as Map<number, CborValue>;
  return (m.get(6) as Map<number, CborValue>[]).find(v => v.get(0) === 13)!;
}

describe("explicit runtime-v1 mutation family", () => {
  it("carries Op18, and the older parent whole-refuses its critical tag", () => {
    const oldAttach = union<FileAttach>("old-file-attach", [[13, "file_attach", [
      [1, "id", uuid], [2, "path", tstr], [3, "content", attachmentContentV1],
      [4, "ifRevision", hash, "opt"], [5, "base", hash, "opt"],
    ]]]);
    const oldParent = (raw: CborValue) => {
      const ops = (raw as Map<number, CborValue>).get(6) as Map<number, CborValue>[];
      for (const v of ops) if (v.get(0) === 13 || Number(v.get(0)) >= 18) oldAttach.dec(v);
      return runtimeMutation.dec(raw);
    };
    expect(() => oldParent(decode(fixture()))).not.toThrow();
    const bytes = new Uint8Array(readFileSync(join(root, "runtime-v1-ordinary-continuation.cbor")));
    const raw = decode(bytes), typed = runtimeMutation.dec(raw);
    expect(toHex(encode(runtimeMutation.enc(typed)))).toBe(toHex(bytes));
    let refused: unknown; try {oldParent(raw);} catch(e) {refused=e;}
    expect(refused).toBeInstanceOf(SchemaError); expect((refused as SchemaError).unknown).toBe(true);
    const bad = decode(new Uint8Array(readFileSync(join(root, "runtime-v1-short-continuation-prior.bad.cbor"))));
    refused=undefined; try {runtimeMutation.dec(bad);} catch(e) {refused=e;}
    expect(refused).toBeInstanceOf(SchemaError); expect((refused as SchemaError).unknown).toBe(false);
  });
  it("roundtrips the actual Rust mixed fixture without widening defaults", () => {
    const bytes = fixture(), raw = decode(bytes), typed = runtimeMutation.dec(raw);
    expect(typed.ops.some(v => v.kind === "file_attach")).toBe(true);
    expect(toHex(encode(runtimeMutation.enc(typed)))).toBe(toHex(bytes));
    expect(() => mutation.dec(raw)).toThrow(); expect(() => op.dec(attach())).toThrow();
  });
  it("delegates legacy ops byte-identically and rejects unknown critical ops", () => {
    const raw = decode(fixture()) as Map<number, CborValue>;
    for (const v of raw.get(6) as CborValue[]) {
      if ((v as Map<number, CborValue>).get(0) === 13) continue;
      expect(toHex(encode(runtimeOp.enc(runtimeOp.dec(v))))).toBe(toHex(encode(op.enc(op.dec(v)))));
    }
    const unknown = attach(); unknown.set(0, 19); expect(() => runtimeOp.dec(unknown)).toThrow();
  });
  it("roundtrips all extended operations while legacy parents refuse each as critical", () => {
    const bytes = new Uint8Array(readFileSync(join(root, "runtime-v1-extended.cbor")));
    const raw = decode(bytes) as Map<number, CborValue>, typed = runtimeMutation.dec(raw);
    expect(typed.ops.slice(3).map(v => v.kind)).toEqual([
      "unindexed_markdown_put", "record_to_unindexed_markdown", "unindexed_markdown_to_record", "ordinary_file_to_record",
    ]);
    expect(toHex(encode(runtimeMutation.enc(typed)))).toBe(toHex(bytes));
    const operations = (raw.get(6) as Map<number, CborValue>[]).filter(v => Number(v.get(0)) >= 14);
    expect(operations).toHaveLength(4);
    for (const v of operations) {
      const parent = new Map(raw);
      parent.set(6, [v]);
      for (const dec of [() => op.dec(v), () => mutation.dec(parent)]) {
        let rejected: unknown;
        try { dec(); } catch (e) { rejected = e; }
        expect(rejected).toBeInstanceOf(SchemaError);
        expect((rejected as SchemaError).unknown).toBe(true);
      }
      expect(toHex(encode(runtimeOp.enc(runtimeOp.dec(v))))).toBe(toHex(encode(v)));
    }
  });
  it("qualifies malformed current bodies, not vacuous unknown-op rejection", () => {
    for (const name of ["runtime-v1-reindex-missing-prior", "runtime-v1-promotion-missing-prior", "runtime-v1-promotion-short-prior-hash"]) {
      let rejected: unknown;
      try { runtimeMutation.dec(decode(new Uint8Array(readFileSync(join(root, `${name}.bad.cbor`))))); }
      catch (e) { rejected = e; }
      expect(rejected).toBeInstanceOf(SchemaError);
      expect((rejected as SchemaError).unknown).toBe(false);
    }
  });
  it("enforces exactly four content and six reference elements", () => {
    const content = attach().get(3) as CborValue[], ref = content[1] as CborValue[];
    for (const bad of [content.slice(0, 3), [...content, 0]]) expect(() => attachmentContentV1.dec(bad)).toThrow();
    for (const bad of [ref.slice(0, 5), [...ref, 0]]) expect(() => attachmentRefV1.dec(bad)).toThrow();
  });
  it("rejects unknown content/ref versions and chunk profiles", () => {
    const content = attach().get(3) as CborValue[], ref = content[1] as CborValue[];
    const wrongContent = [...content]; wrongContent[0] = 2;
    expect(() => attachmentContentV1.dec(wrongContent)).toThrow();
    const wrongRef = [...ref]; wrongRef[0] = 2;
    expect(() => attachmentRefV1.dec(wrongRef)).toThrow();
    for (const size of [0, 16_777_216, 1_048_576]) {
      const bad = [...ref]; bad[4] = size; expect(() => attachmentRefV1.dec(bad)).toThrow();
    }
  });
  it("rejects short hashes/IDs and out-of-u64 values while preserving exact uint64", () => {
    const content = attach().get(3) as CborValue[], ref = content[1] as CborValue[];
    for (const at of [3, 5]) {
      const bad = [...ref]; bad[at] = new Uint8Array(31); expect(() => attachmentRefV1.dec(bad)).toThrow();
    }
    const epoch = [...ref]; epoch[2] = 0xffffffffffffffffn;
    expect(attachmentRefV1.dec(epoch).keyEpoch).toBe(0xffffffffffffffffn);
    expect(encode(attachmentRefV1.enc(attachmentRefV1.dec(epoch)))).toEqual(encode(epoch));
    const length = [...content]; length[3] = 0xffffffffffffffffn;
    expect(attachmentContentV1.dec(length).totalPlainBytes).toBe(0xffffffffffffffffn);
    expect(encode(attachmentContentV1.enc(attachmentContentV1.dec(length)))).toEqual(encode(length));
    epoch[2] = 0x10000000000000000n; expect(() => attachmentRefV1.dec(epoch)).toThrow();
    length[3] = 0x10000000000000000n; expect(() => attachmentContentV1.dec(length)).toThrow();
  });
  it("fails the entire runtime parent on the actual schema-negative fixtures", () => {
    for (const name of ["runtime-v1-short-manifest-hash.bad.cbor", "runtime-v1-unknown-content.bad.cbor", "runtime-v1-unknown-op.bad.cbor"]) {
      expect(() => runtimeMutation.dec(decode(new Uint8Array(readFileSync(join(root, name)))))).toThrow();
    }
  });
});
