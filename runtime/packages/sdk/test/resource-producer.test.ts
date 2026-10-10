import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {decode, encode, fromHex, type CborValue} from "../src/cbor.js";
import {resourceView} from "../src/wire.js";
const bytes = fromHex(readFileSync(new URL("../../../conformance/resources/get.hex", import.meta.url), "utf8").trim());
const source = () => (decode(bytes) as Map<number,CborValue>).get(2)!;

describe("native resource source producer", () => {
  it("decodes the exact native confirmed source response and roundtrips bytes", () => {
    const result = resourceView.dec(source());
    expect(result).toEqual({path:"_types/task.md",revision:`sha256:${"08".repeat(32)}`,size:3,state:"confirmed",text:"abc"});
    const frame = decode(bytes) as Map<number,CborValue>;
    frame.set(2,resourceView.enc(result));
    expect(encode(frame)).toEqual(bytes);
  });
  it("accepts the existing pending uint arm without inferring confirmation", () => {
    const value = source() as Map<number,CborValue>;value.set(3,1);
    expect(resourceView.dec(value).state).toBe("pending");
  });
  it("rejects string/unknown confirmation arms", () => {
    for(const arm of ["confirmed","pending",2]) {
      const value = source() as Map<number,CborValue>;value.set(3,arm);
      expect(() => resourceView.dec(value)).toThrow();
    }
  });
});
