import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decode, encode, type CborValue } from "../src/cbor.js";
import { describeResult } from "../src/wire.js";

// The native Frames regression compares its actual Describe result bytes to this
// same fixture. No permissive decoder or application mock substitutes for it.
const bytes = new Uint8Array(Buffer.from(readFileSync(new URL("../../../conformance/describe/populated.hex", import.meta.url), "utf8").trim(), "hex"));

describe("native Describe producer boundary", () => {
  it("decodes exact native TypeSummary and ContractSummary maps", () => {
    const result = describeResult.dec(decode(bytes));
    expect(encode(describeResult.enc(result))).toEqual(bytes);
    expect(result.types).toHaveLength(1);
    expect(result.types[0]).toEqual({
      name: "task", path: "_types/task.md", implements: [{
        contract: "acme.task", version: "1.2.0",
        fields: new Map([["/done", "/completed"]]),
        binding: new Map([["workspace", "personal"]]),
      }],
    });
    expect(result.contracts[0]).toEqual({
      id: "acme.task", version: "1.2.0", path: "_contracts/task.md",
      digest: `sha256:${"55".repeat(32)}`, contractType: "record", implementedBy: ["task"],
    });
  });
  it("keeps required empty types and contracts arrays", () => {
    const result = { ...describeResult.dec(decode(bytes)), types: [], contracts: [] };
    expect(describeResult.dec(decode(encode(describeResult.enc(result))))).toEqual(result);
  });
  it("continues refusing the legacy missing contracts key", () => {
    const legacy = decode(bytes) as Map<number, CborValue>;
    legacy.delete(5);
    expect(() => describeResult.dec(legacy)).toThrow(/contracts/);
  });
  it("continues refusing legacy type-name strings even with contracts key5", () => {
    const legacy = decode(bytes) as Map<number, CborValue>;
    legacy.set(1, ["task"]);
    expect(() => describeResult.dec(legacy)).toThrow();
  });
});
