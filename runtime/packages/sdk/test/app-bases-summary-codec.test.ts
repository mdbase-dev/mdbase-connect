import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {decode, encode, Float64, fromHex, type CborValue} from "../src/cbor.js";
import {decodeAppBasesResult} from "../src/app-host/bases-wire.js";
const legacy = JSON.parse(readFileSync(new URL("./fixtures/native-bases-app-codec.json", import.meta.url), "utf8")) as {success_hex: string};
const addon = JSON.parse(readFileSync(new URL("./fixtures/native-bases-summary-codec.json", import.meta.url), "utf8")) as {suffix_hex: string};
const native = fromHex(`a8${legacy.success_hex.slice(2)}${addon.suffix_hex}`);
const wire = () => decode(native) as Map<number, CborValue>;
function refuses(value: CborValue) {const m = wire(); m.set(9, value); expect(() => decodeAppBasesResult(encode(m))).toThrow();}
describe("optional native whole-match summaries field 9 (codec only)", () => {
  it("preserves native bytes and named binary64 values while accepting old results", () => {
    expect(encode(decode(native))).toEqual(native);
    const result = decodeAppBasesResult(native);
    if (result.kind !== "success") throw Error("success required");
    expect(result.summaries).toEqual(new Map([["all", {kind: "number", value: 3}], ["total", {kind: "number", value: 6}]]));
    expect(result.rows).toHaveLength(1);
    const old = decodeAppBasesResult(fromHex(legacy.success_hex));
    expect("summaries" in old).toBe(false);
  });
  it("coexists with independent window placement without changing totals", () => {
    const m = wire(), summaries = m.get(9)!; m.delete(9);
    m.set(8, new Map<number, CborValue>([[0, 0], [1, 1], [2, 1], [3, [[0, 1, [0]]]]])); m.set(9, summaries);
    const result = decodeAppBasesResult(encode(m), {offset: 0, limit: 1});
    if (result.kind !== "success") throw Error("success required");
    expect(result.window?.totalMatchedRows).toBe(1); expect(result.summaries?.get("all")).toEqual({kind: "number", value: 3});
  });
  it("rejects duplicate/empty/control/oversized names, wrong arity and future fields", () => {
    for (const name of ["", "\u0000", "x".repeat(1025)]) refuses([[name, [0]]]);
    refuses([["same", [0]], ["same", [0]]]); refuses([["name"]]); refuses([["name", [0], 1]]);
    refuses(Array.from({length: 65}, (_, i) => [`s${i}`, [0]]));
    const m = wire(); m.set(10, []); expect(() => decodeAppBasesResult(encode(m))).toThrow();
  });
  it("bounds aggregate nodes/bytes/depth and refuses unavailable/future/invalid numeric values", () => {
    refuses([["all", [6, Array.from({length: 4096}, () => [0])]]]);
    refuses(Array.from({length: 64}, (_, i) => [`s${i}`, [6, Array.from({length: 5}, () => [3, "x".repeat(4096)])]]));
    let deep: CborValue = [0]; for (let i = 0; i < 33; i++) deep = [6, [deep]];
    refuses([["deep", deep]]);
    refuses([["bad", [9, "code", "detail"]]]); refuses([["bad", [10]]]); refuses([["bad", [2, 3]]]);
    const m = wire(); m.set(9, [["negativeZero", [2, new Float64(-0)]]]);
    const result = decodeAppBasesResult(encode(m));
    if (result.kind !== "success") throw Error("success required");
    const cell = result.summaries?.get("negativeZero"); expect(cell?.kind).toBe("number");
    if (cell?.kind === "number") expect(Object.is(cell.value, -0)).toBe(true);
  });
});
