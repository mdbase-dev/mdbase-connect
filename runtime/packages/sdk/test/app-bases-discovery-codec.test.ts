import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {encode,decode,fromHex,type CborValue} from "../src/cbor.js";
import {revisionOf} from "../src/values.js";
import {encodeAppBasesDiscoveryRequest,encodeAppBasesSourceRequest,decodeAppBasesDiscoveryResult,decodeAppBasesSourceResult} from "../src/app-host/bases-wire.js";
import {hash,uuid} from "../src/codec.js";
const record="11111111-1111-1111-1111-111111111111", source="views:\n  - name: same\n    type: table\n";
const revision=revisionOf(source), digest=`sha256:${"33".repeat(32)}`;
const clock=new Map<number,CborValue>([[0,0],[1,"UTC"],[2,"1970-01-01"]]);
function descriptor(ordinal=0,sha=revision):Map<number,CborValue> {
  return new Map([[0,uuid.enc(record)],[1,"Views/actual.base"],[2,hash.enc(sha)],[3,ordinal],[4,"same"],[5,"table"],[6,[new Map([[0,"FixtureType"],[1,"1.0.0"],[2,hash.enc(digest)],[3,hash.enc(digest)]])]]]);
}
function page(views:CborValue[]=[],next:CborValue=null):Map<number,CborValue>{return new Map([[0,1],[1,views],[2,clock],[3,hash.enc(digest)],[4,next]]);}
function exact(text=source,view:CborValue=descriptor()):Map<number,CborValue>{return new Map([[0,1],[1,view],[2,text],[3,clock],[4,hash.enc(digest)]]);}
const request={record,sourceRevision:revision,ordinal:0,captureTimezone:"UTC"};
const nativeFixture = JSON.parse(readFileSync(new URL("./fixtures/native-bases-app-discovery-codec.json",import.meta.url),"utf8")) as Record<string,string>;
describe("native byte fixture shared with the Rust encoder (grammar only)",()=>{
  it("matches native canonical list/resume/source request bytes",()=>{
    expect(encodeAppBasesDiscoveryRequest({captureTimezone:"UTC",limit:2})).toEqual(fromHex(nativeFixture.initial_request_hex!));
    expect(encodeAppBasesDiscoveryRequest({captureTimezone:"UTC",limit:2,continuation:new Uint8Array(32).fill(0x55)})).toEqual(fromHex(nativeFixture.resume_request_hex!));
    expect(encodeAppBasesSourceRequest({...request,sourceRevision:nativeFixture.source_revision!,ordinal:2})).toEqual(fromHex(nativeFixture.source_request_hex!));
  });
  it("decodes native repeated-name ordinals and distinguishes real empty progress from EOF",()=>{
    expect(decodeAppBasesDiscoveryResult(fromHex(nativeFixture.list_success_hex!),2)).toMatchObject({kind:"success",views:[{ordinal:0,name:"same"},{ordinal:2,name:"same"}]});
    expect(decodeAppBasesDiscoveryResult(fromHex(nativeFixture.empty_progress_hex!),2)).toMatchObject({kind:"success",views:[],continuation:new Uint8Array(32).fill(0x55)});
    expect(decodeAppBasesDiscoveryResult(fromHex(nativeFixture.eof_hex!),2)).toMatchObject({kind:"success",views:[],continuation:null});
  });
  it("decodes native exact UTF8 source/SHA/original ordinal without synthetic document fallback",()=>{
    expect(decodeAppBasesSourceResult(fromHex(nativeFixture.source_success_hex!),{...request,sourceRevision:nativeFixture.source_revision!,ordinal:2})).toMatchObject({kind:"success",source:nativeFixture.source,view:{sourceRevision:nativeFixture.source_revision,ordinal:2}});
  });
});
describe("separate bounded native discovery grammar (synthetic codec fixtures, not catalog proof)",()=>{
  it("encodes canonical primary request and fixed 32-byte handle, not Query cursor",()=>{
    const token=new Uint8Array(32).fill(7),bytes=encodeAppBasesDiscoveryRequest({captureTimezone:"UTC",limit:128,continuation:token});
    expect(decode(bytes)).toEqual(new Map<number,CborValue>([[0,1],[1,"UTC"],[2,128],[3,token]]));
    expect(()=>encodeAppBasesDiscoveryRequest({captureTimezone:"UTC",limit:0})).toThrow();
    expect(()=>encodeAppBasesDiscoveryRequest({captureTimezone:"UTC",limit:129})).toThrow();
    expect(()=>encodeAppBasesDiscoveryRequest({captureTimezone:"UTC",limit:1,continuation:new Uint8Array(31)})).toThrow();
  });
  it("encodes exact native UUID SHA original ordinal with no aliases or sources",()=>{
    expect(decode(encodeAppBasesSourceRequest(request))).toEqual(new Map([[0,1],[1,uuid.enc(record)],[2,hash.enc(revision)],[3,0],[4,"UTC"]]));
    expect(()=>encodeAppBasesSourceRequest({...request,ordinal:0x100000000})).toThrow();
  });
  it("empty descriptor page with continuation is progress not EOF",()=>{
    const result=decodeAppBasesDiscoveryResult(encode(page([],new Uint8Array(32).fill(8))));
    expect(result.kind).toBe("success");if(result.kind!=="success")throw Error("success");
    expect(result.views).toEqual([]);expect(result.continuation?.length).toBe(32);
    expect(decodeAppBasesDiscoveryResult(encode(page()))).toMatchObject({kind:"success",continuation:null});
  });
  it("retains duplicate names with distinct original ordinals",()=>{
    const result=decodeAppBasesDiscoveryResult(encode(page([descriptor(0),descriptor(2)])),2);
    expect(result).toMatchObject({kind:"success",views:[{name:"same",ordinal:0},{name:"same",ordinal:2}]});
    expect(()=>decodeAppBasesDiscoveryResult(encode(page([descriptor(0),descriptor(2)])),1)).toThrow();
  });
  it.each([[0,0],[2,1]])("refuses repeated/decreasing actual source ordinal %i %i",(a,b)=>{
    expect(()=>decodeAppBasesDiscoveryResult(encode(page([descriptor(a),descriptor(b)])))).toThrow();
  });
  it("refuses same source with two SHA/path identities and no implementation provenance",()=>{
    expect(()=>decodeAppBasesDiscoveryResult(encode(page([descriptor(0),descriptor(1,digest)])))).toThrow();
    const d=descriptor();d.set(6,[]);expect(()=>decodeAppBasesDiscoveryResult(encode(page([d])))).toThrow();
  });
  it("refuses malformed/trailing/version/extra-field/handle/frame bounds before publication",()=>{
    for(const [k,v] of [[0,2],[4,"not native"],[4,new Uint8Array(33)],[8,0]] as [number,CborValue][]){const p=page();p.set(k,v);expect(()=>decodeAppBasesDiscoveryResult(encode(p))).toThrow();}
    const bytes=encode(page());expect(()=>decodeAppBasesDiscoveryResult(new Uint8Array([...bytes,0]))).toThrow();
    expect(()=>decodeAppBasesDiscoveryResult(new Uint8Array(1024*1024+1))).toThrow();
  });
  it("returns exact formatting + SHA and original ordinal; rejects stale identity echoes",()=>{
    expect(decodeAppBasesSourceResult(encode(exact()),request)).toMatchObject({kind:"success",source,view:{record,sourceRevision:revision,ordinal:0}});
    expect(()=>decodeAppBasesSourceResult(encode(exact()),{...request,ordinal:1})).toThrow();
    expect(()=>decodeAppBasesSourceResult(encode(exact(source+"\n")),request)).toThrow();
  });
  it("source text has a separate 512KiB bound, not display's 4096 bytes",()=>{
    const text="é".repeat(3000);expect(decodeAppBasesSourceResult(encode(exact(text,descriptor(0,revisionOf(text)))))).toMatchObject({kind:"success",source:text});
    const large="é".repeat(256*1024+1);expect(()=>decodeAppBasesSourceResult(encode(exact(large,descriptor(0,revisionOf(large)))))).toThrow();
  });
});
