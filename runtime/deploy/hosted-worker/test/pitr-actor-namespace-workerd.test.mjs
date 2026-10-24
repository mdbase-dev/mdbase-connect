// Real local workerd namespaces/IDs and actual required constructor/activation.
// Empty WASM and synthetic phase port; no native admission/provider/PITR claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const compiled=await build({stdin:{resolveDir:fileURLToPath(new URL("../",import.meta.url)),loader:"js",sourcefile:"pitr-namespace-test.js",contents:`
  import { HostedCollection as RequiredActor } from "./src/pitr-worker.ts";
  const A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",D="dddddddd-dddd-4ddd-addd-dddddddddddd",NIL="00000000-0000-0000-0000-000000000000";
  class Harness extends RequiredActor {
    constructor(ctx,env){
      let gets=0;
      const binding={run:"gate4-pitr-lab-20261009-01",active:A,deleted:D,codeConfigSha256:"ab".repeat(32),members:[
        ...[A,D].map(collection=>({kind:"log",collection,namespace:"01".repeat(16),object:env.LOGS.idFromName(collection).toString()})),
        {kind:"registry",collection:NIL,namespace:"01".repeat(16),object:env.LOGS.idFromName(NIL).toString()},
        ...[A,D].map(collection=>({kind:"hosted",collection,namespace:"02".repeat(16),object:env.COLLECTIONS.idFromName(collection).toString()}))]};
      const scoped=Object.create(env);
      Object.defineProperties(scoped,{LAB:{value:"1"},SERVICE_KIND:{value:"hosted"},PITR_BINDING:{value:JSON.stringify(binding)},PITR_MINIMUM_EPOCH:{value:"1"},
        PITR_PHASE:{value:{async get(){gets++;const bytes=new TextEncoder().encode(JSON.stringify({schema:"mdbn-lab-pitr-phase/1",binding,epoch:7,phase:"seed",issuedAt:Date.now()-1000,expiresAt:Date.now()+60000}));
          return {size:bytes.length,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})};}}}});
      for(const key of ["LAB_HOSTED_CONFIG","HOSTED_SERVICE_TOKEN","CP_INBOUND_TOKEN","HOSTED_KMS_KEY_ID","AWS_SECRET_ACCESS_KEY"])
        Object.defineProperty(scoped,key,{get(){throw new Error("forbidden custody setting");}});
      super(ctx,scoped);this.phaseGets=()=>gets;
    }
    async fetch(request){
      const response=await super.fetch(request);
      return Response.json({status:response.status,noStore:response.headers.get("cache-control"),phaseGets:this.phaseGets(),
        restriction:this.pitrRestriction!==null,cut:this.pitrCut!==null,engine:this.engine===null,production:this.production===null,
        drained:this.pitrWork.drained});
    }
  }
  export class Actual extends Harness {}
  export class Foreign extends Harness {}
  export class Logs extends Harness {}
  export default {fetch(request,env){const u=new URL(request.url),kind=u.searchParams.get("kind"),collection=u.searchParams.get("collection");
    const ns=kind==="foreign"?env.FOREIGN:kind==="log"?env.LOGS:env.COLLECTIONS;
    return ns.getByName(collection).fetch(new Request("https://actor.test/v1/hosted/activate?collection="+collection,{method:"POST"}));}};
`},bundle:true,write:false,format:"esm",platform:"browser",external:["cloudflare:workers"],plugins:[{
  name:"never-opened-wasm",setup(b){b.onResolve({filter:/hosted\.wasm$/},()=>({path:"wasm",namespace:"empty-wasm"}));
    b.onLoad({filter:/.*/,namespace:"empty-wasm"},()=>({contents:"export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));"}));}
}]});
const A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",D="dddddddd-dddd-4ddd-addd-dddddddddddd",NIL="00000000-0000-0000-0000-000000000000";
test("actual A/D namespace matches while foreign/log namespaces and nil/nonmembers remain closed",async()=>{
  const prefix=fileURLToPath(new URL("../../../target/pa-",import.meta.url));mkdirSync(dirname(prefix),{recursive:true});const scratch=mkdtempSync(prefix);
  const oldTmp=process.env.TMPDIR;process.env.TMPDIR=scratch;let mf,passed=false;
  try{
    mf=new Miniflare(convertV4MiniflareOptions({name:"pitr-native-namespace-test",modules:true,script:compiled.outputFiles[0].text,compatibilityDate:"2026-10-05",
      durableObjects:{COLLECTIONS:{className:"Actual",useSQLite:true},FOREIGN:{className:"Foreign",useSQLite:true},LOGS:{className:"Logs",useSQLite:true}},
      resourcePersistencePath:scratch,resourceTmpPath:scratch,port:0}));
    for(const [kind,collection,expected] of [["actual",A,true],["actual",D,true],["foreign",A,false],["foreign",D,false],
      ["log",A,false],["actual",NIL,false],["actual","33333333-3333-4333-a333-333333333333",false]]){
      const response=await mf.dispatchFetch("https://fixture.test/?kind="+kind+"&collection="+collection);
      assert.equal(response.status,200,await response.clone().text());const r=await response.json();
      assert.deepEqual(r,{status:503,noStore:"no-store",phaseGets:expected?1:0,restriction:expected,cut:expected,engine:true,production:true,drained:true});
    }
    passed=true;
  }finally{
    await mf?.dispose();if(oldTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmp;
    if(passed)rmSync(scratch,{recursive:true});else console.error("Retained local namespace evidence: "+scratch);
  }
});
