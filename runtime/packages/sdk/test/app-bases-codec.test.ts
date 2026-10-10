import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decode, encode, Float64, fromHex, type CborValue } from "../src/cbor.js";
import { problem, opClock } from "../src/wire.js";
import { APP_BASES_PROFILE, decodeAppBasesCell, decodeAppBasesResult, encodeAppBasesRequest, type AppBasesRequest } from "../src/app-host/bases-wire.js";
const rawFixture = readFileSync(new URL("./fixtures/native-bases-app-codec.json", import.meta.url));
const fixture = JSON.parse(rawFixture.toString()) as {kind: string; profile: string; request_hex: string; success_hex: string; refusal_hex: string; cells: {case: string; hex: string}[]};
const request: AppBasesRequest = {record: "11111111-1111-1111-1111-111111111111", sourceRevision: `sha256:${"22".repeat(32)}`, ordinal: 3, hints: new Map([["due", "date"], ["scheduled", "date"]]), captureTimezone: "UTC"};
const success = () => decode(fromHex(fixture.success_hex)) as Map<number, CborValue>;
const row = (m: Map<number, CborValue>) => (m.get(3) as CborValue[][])[0]!;
const cells = (m: Map<number, CborValue>) => row(m)[3] as CborValue[];
function refusalAfter(change: (m: Map<number, CborValue>) => void) {
  const m = success(); change(m); expect(() => decodeAppBasesResult(encode(m))).toThrow();
}
describe("ONE native Bases codec grammar (not execution/paging/authority proof)", () => {
  it("pins actual native fixture and emits the exact six-key fixed-profile request", () => {
    expect(createHash("sha256").update(rawFixture).digest("hex")).toBe("2342bb19881622df59b1f949eebd5c0c0a9e6b5e6ccd17e2cc128c79f8303e1d");
    expect(fixture.kind).toBe("native-codec-grammar-only-not-execution-proof");
    expect(fixture.profile).toBe(APP_BASES_PROFILE);
    expect(encodeAppBasesRequest(request)).toEqual(fromHex(fixture.request_hex));
    const wire = decode(encodeAppBasesRequest({...request, profile: "not-authority"} as AppBasesRequest)) as Map<number, CborValue>;
    expect([...wire.keys()]).toEqual([0, 1, 2, 3, 4, 5]); expect(wire.get(5)).toBe(APP_BASES_PROFILE);
  });
  it("decodes the complete native success without relabelling provenance/order", () => {
    const result = decodeAppBasesResult(fromHex(fixture.success_hex));
    expect(result.kind).toBe("success"); if (result.kind !== "success") throw Error("success");
    expect(result.view).toEqual({record: request.record, path: "TaskNotes/Views/example.base", sourceRevision: request.sourceRevision, ordinal: 3, name: "Example", viewType: "table", implementations: [{typeName: "obsidian_base", version: "1", contractDigest: `sha256:${"44".repeat(32)}`, implementationDigest: `sha256:${"55".repeat(32)}`} ]});
    expect(result.columns).toEqual(Array.from({length: 15}, (_, i) => `note["col${i}"]`));
    expect(result.unavailableColumns).toEqual([{index: 13, code: "view_metadata_unavailable", detail: "file_tasks_unqualified"}]);
    expect(result.rows[0]).toMatchObject({record: "66666666-6666-6666-6666-666666666666", path: "Tasks/example.md", sourceRevision: `sha256:${"77".repeat(32)}`});
    const values = result.rows[0]!.cells;
    expect(values[0]).toEqual({kind: "null"}); expect(values[1]).toEqual({kind: "boolean", value: true});
    expect(values[2]).toEqual({kind: "number", value: 1.25}); expect(Object.is((values[3] as {value: number}).value, -0)).toBe(true);
    expect(values.slice(5, 9)).toEqual([
      {kind: "date", millis: 1781049600000, display: "2026-06-10", authoritativeZone: "UTC", dateOnly: true},
      {kind: "date", millis: 1781028900000, display: "2026-06-10", authoritativeZone: "+05:45", dateOnly: true},
      {kind: "date", millis: 1781064000000, display: "2026-06-10", authoritativeZone: "America/New_York", dateOnly: true},
      {kind: "date", millis: 1781064000000, display: "2026-06-10", authoritativeZone: "US/Eastern", dateOnly: true},
    ]);
    expect(values[9]).toEqual({kind: "duration", components: [0, 0, 0, 0, 1, 0, 0, 0], display: "an hour"});
    expect(values[10]).toEqual({kind: "list", values: [{kind: "null"}, {kind: "boolean", value: true}, {kind: "text", value: "x"}]});
    expect(values[11]).toEqual({kind: "map", values: new Map([["a", {kind: "null"}], ["b", {kind: "text", value: "x"}]])});
    expect(values[12]).toEqual({kind: "error", message: "source error"});
    expect(values[13]).toEqual({kind: "unavailable", code: "view_metadata_unavailable", detail: "file_tasks_unqualified"});
    expect(values[14]).toEqual({kind: "error", message: "non_finite_number"});
    expect(result.groups).toEqual([{key: {kind: "text", value: "open"}, rowIndices: [0]}]);
    expect(result.clock).toEqual(opClock.dec(success().get(5)!)); expect(result.collectionRevision).toBe(`sha256:${"33".repeat(32)}`);
  });
  it.each(fixture.cells)("decodes actual native $case bytes without changing binary64", ({hex}) => {
    const value = decode(fromHex(hex)); expect(() => decodeAppBasesCell(value)).not.toThrow(); expect(encode(value)).toEqual(fromHex(hex));
  });
  it("uses the shared Problem directly and never mixes refusal with success", () => {
    const bytes = fromHex(fixture.refusal_hex), wire = decode(bytes) as Map<number, CborValue>;
    expect(decodeAppBasesResult(bytes)).toEqual({kind: "refusal", problem: problem.dec(wire.get(7)!)});
    refusalAfter(m => m.set(7, wire.get(7)!));
    wire.set(3, []); expect(() => decodeAppBasesResult(encode(wire))).toThrow();
  });
  it.each([0, 1, 2, 3, 4, 5, 6])("refuses missing success key %i or any unknown field", key => {
    refusalAfter(m => m.delete(key)); refusalAfter(m => m.set(8, 1));
  });
  it("refuses unknown versions and future/Missing cell tags as whole results", () => {
    refusalAfter(m => m.set(0, 2));
    for (const tag of [10, 11, 99]) refusalAfter(m => {cells(m)[0] = [tag];});
    expect(() => decodeAppBasesCell([10])).toThrowError(expect.objectContaining({unknown: true}));
  });
  it.each(([[], [0, null], [1], [1, "true"], [2, 1], [2, null], [3, 5], [4, 1, "display", "UTC"], [4, 9007199254740992n, "display", "UTC", false], [5, [], "duration"], [5, Array(8).fill(1), "duration"], [6, null], [7, []], [8], [9, "code"]] as CborValue[]).map(value => ({value})))("refuses malformed typed cell %#", ({value}) => {
    expect(() => decodeAppBasesCell(value)).toThrow(); refusalAfter(m => {cells(m)[0] = value;});
  });
  it("preserves duration negative-zero bits and never treats integer major type as f64", () => {
    const c = decodeAppBasesCell([5, [new Float64(-0), ...Array(7).fill(new Float64(0))], "qualified"]);
    if (c.kind !== "duration") throw Error("duration"); expect(Object.is(c.components[0], -0)).toBe(true);
    expect(() => decodeAppBasesCell([2, Infinity])).toThrow(); expect(() => decodeAppBasesCell([2, new Float64(NaN)])).toThrow();
  });
  it("refuses bad cardinalities and out-of-bounds row/column/group indices", () => {
    refusalAfter(m => {row(m)[3] = [];});
    refusalAfter(m => {const columns = m.get(2) as Map<number, CborValue>; columns.set(0, Array(65).fill("note[\"x\"]"));});
    refusalAfter(m => {const columns = m.get(2) as Map<number, CborValue>; columns.set(1, [new Map<number, CborValue>([[0, 15], [1, "bad"], [2, "bad"]])]);});
    refusalAfter(m => m.set(4, [[[3, "x"], [1]]]));
    refusalAfter(m => m.set(4, [[[3, "x"], [-1]]]));
    for (const key of [[6, []], [7, new Map()], [8, "error"], [9, "code", "detail"]] as CborValue[]) refusalAfter(m => m.set(4, [[key, [0]]]));
    refusalAfter(m => m.set(3, Array(65537).fill(row(m))));
  });
  it("bounds cell value depth/list/map/text before typed copies", () => {
    let nested: CborValue = [0]; for (let i = 0; i < 31; i++) nested = [6, [nested]];
    expect(() => decodeAppBasesCell(nested)).not.toThrow(); expect(() => decodeAppBasesCell([6, [nested]])).toThrow();
    expect(() => decodeAppBasesCell([6, Array(4097).fill([0])])).toThrow();
    expect(() => decodeAppBasesCell([7, new Map(Array.from({length: 4097}, (_, i) => [String(i), [0]] as [string, CborValue]))])).toThrow();
    expect(() => decodeAppBasesCell([3, "😀".repeat(1025)])).toThrow();
    expect(() => decodeAppBasesCell([7, new Map([["b", [0]], ["a", [0]]])])).toThrow();
    expect(() => decodeAppBasesCell([7, new Map([["\ue000", [0]], ["😀", [0]]])])).not.toThrow();
  });
  it("bounds request hints/timezone/ordinal with the fixed native profile", () => {
    for (const ordinal of [-1, 1.5, 0x100000000]) expect(() => encodeAppBasesRequest({...request, ordinal})).toThrow();
    expect(() => encodeAppBasesRequest({...request, hints: new Map(Array.from({length: 4097}, (_, i) => [String(i), "date"]))})).toThrow();
    expect(() => encodeAppBasesRequest({...request, hints: new Map([["x", "x".repeat(4097)]])})).toThrow();
    expect(() => encodeAppBasesRequest({...request, hints: new Map(Array.from({length: 17}, (_, i) => [String(i), "x".repeat(4096)]))})).toThrow();
    expect(() => encodeAppBasesRequest({...request, captureTimezone: "😀".repeat(33)})).toThrow();
  });
  it("refuses oversize/truncated/trailing/noncanonical bytes before publication", () => {
    expect(() => decodeAppBasesResult(new Uint8Array(16 * 1024 * 1024 + 1))).toThrow();
    const bytes = fromHex(fixture.success_hex);
    expect(() => decodeAppBasesResult(bytes.subarray(0, bytes.length - 1))).toThrow();
    expect(() => decodeAppBasesResult(Uint8Array.from([...bytes, 0]))).toThrow();
    expect(() => decodeAppBasesResult(Uint8Array.of(0xa2, 0, 0x18, 1, 7, 0xa0))).toThrow();
  });
});
