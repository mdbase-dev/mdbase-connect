// Actual fresh Rust/WASM SDK CLOSED actor + LOG wrapper, real workerd IDs.
// Synthetic phase only; no managed resources or native original/currentCP proof.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
const contents=`
import {LogCollection as Required,default as required} from "../../cloudflare-do/src/pitr-worker.mjs";
const A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",D="dddddddd-dddd-4ddd-addd-dddddddddddd",NIL="00000000-0000-0000-0000-000000000000";
function config(env){let gets=0;const binding={run:"gate4-pitr-lab-20261009-01",active:A,deleted:D,codeConfigSha256:"ab".repeat(32),members:[
  ...[A,D].map(collection=>({kind:"log",collection,namespace:"01".repeat(16),object:env.LOG.idFromName(collection).toString()})),
  {kind:"registry",collection:NIL,namespace:"01".repeat(16),object:env.LOG.idFromName(NIL).toString()},
  ...[A,D].map(collection=>({kind:"hosted",collection,namespace:"02".repeat(16),object:env.HOSTED.idFromName(collection).toString()}))]};
  const scoped=Object.create(env);Object.defineProperties(scoped,{PITR_BINDING:{value:JSON.stringify(binding)},PITR_MINIMUM_EPOCH:{value:"1"},PITR_PHASE:{value:{async get(){
    gets++;const bytes=new TextEncoder().encode(JSON.stringify({schema:"mdbn-lab-pitr-phase/1",binding,epoch:7,phase:"seed",issuedAt:Date.now()-1000,expiresAt:Date.now()+60000}));
    return {size:bytes.length,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})};}}}});
  for(const key of ["LOGSVC_ROOT_KEYS","LOGSVC_TOKEN_ISSUERS","LOGSVC_URL_SECRET","INSECURE_TEST_KEYS","OBJECTS","METRICS"])
    Object.defineProperty(scoped,key,{get(){throw Error("unexpected native ordinary secret/binding");}});
  return {scoped,gets:()=>gets};
}
class Harness extends Required{
  constructor(state,env){const f=config(env);super(state,f.scoped);this.testState=state;this.phaseGets=f.gets;}
  async fetch(request){const r=await super.fetch(request);await super.alarm();
    return Response.json({status:r.status,noStore:r.headers.get("cache-control"),phaseGets:this.phaseGets(),alarm:await this.testState.storage.getAlarm(),
      tables:[...this.testState.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%'")].map(r=>r.name)});}
}
export class Logs extends Harness{}export class Hosted extends Harness{}export class Foreign extends Harness{}
async function heldNativeAlarm(){
  const calls=[],id=(name,space="log")=>({toString:()=>name===A?space==="log"?"01".repeat(32):"04".repeat(32):name===D?space==="log"?"02".repeat(32):"05".repeat(32):"03".repeat(32),
    equals:other=>other.name===name&&other.space===space,name,space});
  const f=config({LOG:{idFromName:c=>id(c)},HOSTED:{idFromName:c=>id(c,"hosted")}}),binding=JSON.parse(f.scoped.PITR_BINDING),scoped=Object.create(f.scoped);
  const issuedAt=Date.now()-1000,expiresAt=Date.now()+600000;
  Object.defineProperty(scoped,"PITR_PHASE",{value:{async get(){const bytes=new TextEncoder().encode(JSON.stringify({schema:"mdbn-lab-pitr-phase/1",binding,epoch:7,phase:"closed",issuedAt,expiresAt}));
    return {size:bytes.length,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})};}}});
  let release,deletes=0;const state={id:id(A),waitUntil(p){calls.push("retain");void p.catch(()=>{});},getWebSockets(){return [];},setWebSocketAutoResponse(){},
    storage:{get sql(){throw Error("unexpected native SQL");},async deleteAlarm(){calls.push("delete");if(++deletes===1)await new Promise(resolve=>{release=resolve;});},
      async sync(){calls.push("sync");},async getCurrentBookmark(){calls.push("bookmark");return "synthetic-native-alarm-cut";}}};
  const actor=new Required(state,scoped),alarm=actor.alarm();await new Promise(resolve=>setTimeout(resolve,0));
  const cut=actor.test_cut.capture();await new Promise(resolve=>setTimeout(resolve,0));
  const before={drained:actor.test_work.drained,sync:calls.includes("sync"),bookmark:calls.includes("bookmark")};release();const nativeResponse=await alarm;const receipt=await cut;
  return {before,drained:actor.test_work.drained,status:nativeResponse.status,bookmark:receipt.bookmark,retained:calls.includes("retain")};
}
export default {fetch(request,env){const u=new URL(request.url);if(u.searchParams.get("kind")==="held")return heldNativeAlarm().then(value=>Response.json(value));
  const c=u.searchParams.get("c"),kind=u.searchParams.get("kind"),target=new Request("https://actor.test/v1/rpc?c="+c,{method:"POST"});
  if(kind==="route")return required.fetch(target,config(env).scoped);
  const ns=kind==="hosted"?env.HOSTED:kind==="foreign"?env.FOREIGN:env.LOG;return ns.getByName(c).fetch(target);}};
`;
const built=await build({stdin:{contents,loader:"js",sourcefile:"pitr-log-real-wasm.js",resolveDir:fileURLToPath(new URL("./",import.meta.url))},bundle:true,write:false,format:"esm",platform:"browser",external:["cloudflare:workers"],loader:{".wasm":"binary"},plugins:[{
  name:"wasm-module",setup(b){b.onLoad({filter:/cloudflare-do\/src\/pitr-worker\.mjs$/},args=>({contents:readFileSync(args.path,"utf8").replace(/#(state|work|restriction|cut|stopResources)\b/g,"test_$1"),loader:"js"}));
    b.onLoad({filter:/index\.js$/},async args=>{if(!args.path.includes("cloudflare-do/build/"))return;
    const {readFileSync}=await import("node:fs");return {contents:readFileSync(args.path,"utf8").replace(/import\s+(\w+)\s+from\s*(["'][^"']+\.wasm["']);/,"import wasmBytes from $2;const $1=new WebAssembly.Module(wasmBytes);"),loader:"js"};});}
}]});
const A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",D="dddddddd-dddd-4ddd-addd-dddddddddddd",NIL="00000000-0000-0000-0000-000000000000";
test("fresh native SDK/WASM required LOG A/D/nil reads phase but never constructs service SQL; foreign IDs refuse",async()=>{
  const prefix=fileURLToPath(new URL("../../../target/pn-",import.meta.url));mkdirSync(dirname(prefix),{recursive:true});const scratch=mkdtempSync(prefix),old=process.env.TMPDIR;
  process.env.TMPDIR=scratch;let mf,passed=false;
  try{
    mf=new Miniflare(convertV4MiniflareOptions({name:"pitr-log-fresh-native",modules:true,script:built.outputFiles[0].text,compatibilityDate:"2026-10-05",durableObjects:{
      LOG:{className:"Logs",useSQLite:true},HOSTED:{className:"Hosted",useSQLite:true},FOREIGN:{className:"Foreign",useSQLite:true}},resourcePersistencePath:scratch,resourceTmpPath:scratch,port:0}));
    for(const [kind,c,gets] of [["log",A,1],["log",D,1],["log",NIL,1],["hosted",A,0],["foreign",NIL,0]]){
      const response=await mf.dispatchFetch("https://fixture.test/?kind="+kind+"&c="+c);assert.equal(response.status,200,await response.clone().text());
      assert.deepEqual(await response.json(),{status:503,noStore:"no-store",phaseGets:gets,alarm:null,tables:[]});
    }
    for(const c of [A,D,NIL])assert.equal((await mf.dispatchFetch("https://fixture.test/?kind=route&c="+c)).status,503);
    const held=await mf.dispatchFetch("https://fixture.test/?kind=held");assert.equal(held.status,200,await held.clone().text());
    assert.deepEqual(await held.json(),{before:{drained:false,sync:false,bookmark:false},drained:true,status:200,bookmark:"synthetic-native-alarm-cut",retained:true});
    passed=true;
  }finally{await mf?.dispose();if(old===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=old;if(passed)rmSync(scratch,{recursive:true});else console.error("Retained native LOG evidence "+scratch);}
});
