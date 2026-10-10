import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decode, encode, fromHex, type CborValue } from "../src/cbor.js";
import { decodeAppBasesResult, encodeAppBasesRequest, type AppBasesRequest } from "../src/app-host/bases-wire.js";
const raw = readFileSync(new URL("./fixtures/native-bases-app-window-codec.json", import.meta.url));
const fixture = JSON.parse(raw.toString()) as {cases: {case: string; offset: number; limit: number; request_hex: string; success_hex: string}[]};
const request: AppBasesRequest = {record: "11111111-1111-1111-1111-111111111111", sourceRevision: `sha256:${"22".repeat(32)}`, ordinal: 3, hints: new Map([["due", "date"], ["scheduled", "date"]]), captureTimezone: "UTC"};
const success = () => decode(fromHex(fixture.cases[0]!.success_hex)) as Map<number, CborValue>;
const window = (m: Map<number, CborValue>) => m.get(8) as Map<number, CborValue>;
const refuses = (change: (m: Map<number, CborValue>) => void) => {const m=success(); change(m); expect(()=>decodeAppBasesResult(encode(m))).toThrow();};
describe("native independent Bases window extension", () => {
 it("pins exact native fixture without claiming execution/render/continuation",()=>{
  expect(createHash("sha256").update(raw).digest("hex")).toBe("0f818ef81245836c332d36b638f2574cb82df5992e007b96279801730deeadb5");
 });
 it.each(fixture.cases)("matches canonical $case request and response",c=>{
  const expected={offset:c.offset,limit:c.limit};
  expect(encodeAppBasesRequest({...request,window:expected})).toEqual(fromHex(c.request_hex));
  const result=decodeAppBasesResult(fromHex(c.success_hex),expected);
  expect(result.kind).toBe("success");if(result.kind!=="success")throw Error("success");
  expect(result.window).toEqual({...expected,totalMatchedRows:1,groupPlacements:c.offset===0?[{globalGroupOrdinal:0,totalGroupRows:1,rowOrdinals:[0]}]:[]});
  expect(result.rows.length).toBe(c.offset===0?1:0);
  expect(result.groups).toEqual(c.offset===0?[{key:{kind:"text",value:"open"},rowIndices:[0]}]:[]);
 });
 it("retains exact absent-window encoding and validates caller echo",()=>{
  const bytes=encodeAppBasesRequest(request), wire=decode(bytes) as Map<number,CborValue>;
  expect([...wire.keys()]).toEqual([0,1,2,3,4,5]);
  const m=success();m.delete(8);
  const full=decodeAppBasesResult(encode(m),null);expect(full.kind).toBe("success");expect("window" in full).toBe(false);
  expect(()=>decodeAppBasesResult(encode(m),{offset:0,limit:200})).toThrow();
  expect(()=>decodeAppBasesResult(fromHex(fixture.cases[0]!.success_hex),null)).toThrow();
  expect(()=>decodeAppBasesResult(fromHex(fixture.cases[0]!.success_hex),{offset:1,limit:200})).toThrow();
  expect(()=>decodeAppBasesResult(fromHex(fixture.cases[0]!.success_hex),{offset:0,limit:199})).toThrow();
 });
 it.each([{offset:-1,limit:200},{offset:0x100000000,limit:200},{offset:0.5,limit:200},{offset:0,limit:0},{offset:0,limit:65537},{offset:0,limit:1.5}])("refuses bad request window %#",w=>{
  expect(()=>encodeAppBasesRequest({...request,window:w})).toThrow();
 });
 it("accepts uint32 max past-end without clamping",()=>{
  const m=success();window(m).set(0,0xffffffff);m.set(3,[]);m.set(4,[]);window(m).set(3,[]);
  const result=decodeAppBasesResult(encode(m),{offset:0xffffffff,limit:200});
  expect(result.kind==="success"&&result.window?.offset).toBe(0xffffffff);
 });
 it.each([0,1,2,3])("refuses missing window key %i",key=>refuses(m=>window(m).delete(key)));
 it("refuses unknown window keys/bounds/count/row cardinality",()=>{
  refuses(m=>window(m).set(4,0));
  for(const [key,value] of [[0,-1],[0,0x100000000],[1,0],[1,65537],[2,65537],[2,0]] as const)refuses(m=>window(m).set(key,value));
  refuses(m=>m.set(3,[]));refuses(m=>window(m).set(3,[]));
 });
 it("rejects empty groups which are not represented by a returned row",()=>{
  refuses(m=>{window(m).set(0,1);m.set(3,[]);m.set(4,[[[3,"open"],[]]]);window(m).set(3,[[0,1,[]]]);});
 });
 it.each([[0,0,[0]],[0,2,[0]],[1,1,[0]],[0,1,[1]],[0,1,[]],[0,1,[0,0]],[0,1,[0,1]]])("refuses malformed aligned group placement %#",p=>refuses(m=>window(m).set(3,[p as CborValue])));
 it("requires strictly increasing global and within-group ordinals",()=>{
  refuses(m=>{const rows=m.get(3) as CborValue[];rows.push(rows[0]!);window(m).set(2,2);m.set(4,[[[3,"a"],[0]],[[3,"b"],[1]]]);window(m).set(3,[[0,1,[0]],[0,1,[0]]]);});
  refuses(m=>{const rows=m.get(3) as CborValue[];rows.push(rows[0]!);window(m).set(2,2);m.set(4,[[[3,"a"],[0,1]]]);window(m).set(3,[[0,2,[1,0]]]);});
 });
});
