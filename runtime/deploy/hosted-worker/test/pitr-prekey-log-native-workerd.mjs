// Opt-in: host76171 + independently qualified native1f156 artifact. Actual SDK
// and workerd opaque IDs, PUBLIC roots and synthetic R2 phase/storage cut ports.
// Native caller is UNAVAILABLE: no slots, CP decoder, witness or positive serving.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
const wasm=readFileSync(new URL("../../cloudflare-do/build/index_bg.wasm",import.meta.url));
assert.equal(createHash("sha256").update(wasm).digest("hex"),"c483a96c156c787383071aa7c426fc8a47c3a0ac9ca2e4d2569d44c5c150a680");
const contents=`
import {LogCollection as Required} from "../../cloudflare-do/src/pitr-worker.mjs";
import {LogCollection as Native} from "../../cloudflare-do/build/worker/shim.mjs";
const A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",D="dddddddd-dddd-4ddd-addd-dddddddddddd",NIL="00000000-0000-0000-0000-000000000000";
const names=["prekeyBegin","prekeyAccept","prekeyCurrent","prekeyFinish"];
function config(env,change){
  const calls={phase:0,private:0,body:0,retain:0};
  const binding={run:"gate4-pitr-lab-20261009-01",active:A,deleted:D,codeConfigSha256:"ab".repeat(32),members:[
    ...[A,D].map(collection=>({kind:"log",collection,namespace:"01".repeat(16),object:env.LOG.idFromName(collection).toString()})),
    {kind:"registry",collection:NIL,namespace:"01".repeat(16),object:env.LOG.idFromName(NIL).toString()},
    ...[A,D].map(collection=>({kind:"hosted",collection,namespace:"02".repeat(16),object:env.HOSTED.idFromName(collection).toString()}))]};
  const scoped=Object.create(env);const issuedAt=Date.now()-1000,expiresAt=Date.now()+60000;
  const values={LAB:"1",SERVICE_KIND:"log",CP_URL:"https://cp.example",LOGSVC_ROOT_KEYS:"48075a597e721a156e2e0799de5cc0c5324dc6e7eaf1cdd46250868ec53215dd",
    PITR_BINDING:JSON.stringify(binding),PITR_MINIMUM_EPOCH:"1",PITR_PHASE:{async get(){calls.phase++;
      const bytes=new TextEncoder().encode(JSON.stringify({schema:"mdbn-lab-pitr-phase/1",binding,epoch:7,phase:"seed",issuedAt,expiresAt}));
      return {size:bytes.length,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})};}}};
  if(change==="no-roots")values.LOGSVC_ROOT_KEYS=undefined;
  if(change==="zero-roots")values.LOGSVC_ROOT_KEYS="0".repeat(64);
  if(change==="duplicate-roots")values.LOGSVC_ROOT_KEYS+=","+values.LOGSVC_ROOT_KEYS;
  if(change==="no-audience")values.CP_URL=undefined;
  if(change==="path-audience")values.CP_URL+="/path";
  if(change==="no-lab")values.LAB=undefined;
  if(change==="wrong-kind")values.SERVICE_KIND="hosted";
  if(change==="bad-floor")values.PITR_MINIMUM_EPOCH="0";
  if(change==="bad-binding")values.PITR_BINDING="{}";
  if(change==="foreign-object"){binding.members[0].object=env.FOREIGN.idFromName(A).toString();values.PITR_BINDING=JSON.stringify(binding);}
  if(change==="foreign-namespace")values.LOG=env.FOREIGN;
  for(const [name,value] of Object.entries(values))Object.defineProperty(scoped,name,{value});
  for(const name of ["PITR_AUTHORITY_TOKEN","LOGSVC_URL_SECRET","LOGSVC_TOKEN_ISSUERS","INSECURE_TEST_KEYS","TESTKIT_CP","OBJECTS","METRICS"])
    Object.defineProperty(scoped,name,{get(){calls.private++;throw Error("private config before native caller");}});
  return {scoped,calls};
}
class Harness extends Required {
  constructor(state,env){const f=config(env,env.TEST_CHANGE);super(state,f.scoped);this.testState=state;this.fixture=f;}
  async fetch(request){globalThis.__nativeError=[];globalThis.__cpCalls=0;
    let pulls=0;const incoming=new Request("https://actor.test/v1/rpc?c="+new URL(request.url).searchParams.get("c"),{
      method:"POST",headers:{authorization:"Bearer synthetic-token","x-mdbase-nonce":"synthetic-not-accepted"},
      body:new ReadableStream({pull(){pulls++;throw Error("body before genuine caller");}},{highWaterMark:0})});
    const r=await super.fetch(incoming);const before=this.test_work.drained;await super.alarm();
    return Response.json({status:r.status,noStore:r.headers.get("cache-control"),pulls,privateReads:this.fixture.calls.private,
      phaseGets:this.fixture.calls.phase,errors:globalThis.__nativeError,cpCalls:globalThis.__cpCalls,drained:[before,this.test_work.drained],
      nativeExports:names.map(n=>typeof Native.prototype[n]),hidden:names.map(n=>typeof this[n]),alarm:await this.testState.storage.getAlarm(),
      tables:[...this.testState.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%'")].map(r=>r.name),
      namespaceDistinct:!this.fixture.scoped.LOG.idFromName(A).equals(this.fixture.scoped.HOSTED.idFromName(A))});}
}
export class Logs extends Harness{}export class Hosted extends Harness{}export class Foreign extends Harness{}
export default {async fetch(request,env){const u=new URL(request.url),c=u.searchParams.get("c"),kind=u.searchParams.get("kind");
  return (kind==="hosted"?env.HOSTED:kind==="foreign"?env.FOREIGN:env.LOG).getByName(c).fetch("https://actor.test/v1/rpc?c="+c,{method:"POST"});}};
`;
const built=await build({stdin:{contents,loader:"js",sourcefile:"pitr-prekey-real-native.js",resolveDir:fileURLToPath(new URL("./",import.meta.url))},bundle:true,write:false,format:"esm",platform:"browser",external:["cloudflare:workers"],loader:{".wasm":"binary"},plugins:[{name:"native-callback-projection",setup(b){
  b.onLoad({filter:/cloudflare-do\/src\/pitr-worker\.mjs$/},args=>({contents:readFileSync(args.path,"utf8").replace(/#(state|work|restriction|cut|stopResources|native|source)\b/g,"test_$1").replace("globalThis.fetch.bind(globalThis)","() => { globalThis.__cpCalls++; throw Error('unexpected CP call'); }"),loader:"js"}));
  b.onLoad({filter:/hosted-worker\/src\/pitr-actor\.ts$/},args=>({contents:readFileSync(args.path,"utf8").replace("await native.begin(request)","await native.begin(request).catch(error => { globalThis.__nativeError.push(String(error)); throw error; })"),loader:"ts"}));
  b.onLoad({filter:/index\.js$/},args=>args.path.includes("cloudflare-do/build/")?({contents:readFileSync(args.path,"utf8").replace(/import\s+(\w+)\s+from\s*(["'][^"']+\.wasm["']);/,"import wasmBytes from $2;const $1=new WebAssembly.Module(wasmBytes);"),loader:"js"}):undefined);
}}]});
const A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",D="dddddddd-dddd-4ddd-addd-dddddddddddd",NIL="00000000-0000-0000-0000-000000000000";
test("host76171 + native1f156 actual SDK/opaque IDs stay closed before caller/body/private/CP/SQL",async()=>{
  const prefix=fileURLToPath(new URL("../../../target/pp-",import.meta.url));mkdirSync(dirname(prefix),{recursive:true});const scratch=mkdtempSync(prefix),old=process.env.TMPDIR;
  process.env.TMPDIR=scratch;let mf,passed=false;let cases=0;
  try{
    for(const change of [undefined,"no-roots","zero-roots","duplicate-roots","no-audience","path-audience","no-lab","wrong-kind","bad-floor","bad-binding","foreign-object","foreign-namespace"]){
      mf=new Miniflare(convertV4MiniflareOptions({name:"pitr-prekey-native-"+(change??"valid"),modules:true,script:built.outputFiles[0].text,compatibilityDate:"2026-10-05",bindings:change?{TEST_CHANGE:change}:{},durableObjects:{
        LOG:{className:"Logs",useSQLite:true},HOSTED:{className:"Hosted",useSQLite:true},FOREIGN:{className:"Foreign",useSQLite:true}},resourcePersistencePath:scratch+"/"+(change??"valid"),resourceTmpPath:scratch,port:0}));
      for(const [kind,c] of change?[["log",A]]:[["log",A],["log",D],["log",NIL],["hosted",A],["foreign",A]]){
        const response=await mf.dispatchFetch("https://fixture.test/?kind="+kind+"&c="+c);assert.equal(response.status,200,await response.clone().text());
        const r=await response.json();assert.equal(r.status,503);assert.equal(r.noStore,"no-store");assert.equal(r.pulls,0);assert.equal(r.privateReads,0);assert.equal(r.cpCalls,0);
        assert.deepEqual(r.nativeExports,Array(4).fill("function"));assert.deepEqual(r.hidden,Array(4).fill("undefined"));assert.deepEqual(r.drained,[true,true]);assert.equal(r.alarm,null);assert.deepEqual(r.tables,[]);
        if(!change&&kind==="log"&&[A,D].includes(c)){assert.deepEqual(r.errors,["prekey_caller_unavailable"]);assert.equal(r.phaseGets,2);assert.equal(r.namespaceDistinct,true);}
        else if(["no-roots","zero-roots","duplicate-roots","no-lab","wrong-kind"].includes(change)){assert.deepEqual(r.errors,["prekey_context_refused"]);assert.equal(r.phaseGets,2);}
        else assert.deepEqual(r.errors,[]);
        cases++;
      }
      await mf.dispose();mf=undefined;
    }
    assert.equal(cases,16);passed=true;
  }finally{await mf?.dispose();if(old===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=old;if(passed)rmSync(scratch,{recursive:true});else console.error("Retained actual pre-key SDK composition evidence "+scratch);}
});
